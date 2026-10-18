# Zernio coverage: stores, administration and additional channels

Snapshot: 18 October 2026, compared with application v0.8.4 and Zernio OpenAPI 1.292.0. This is an implementation backlog, not a claim that the missing features work. The [main breakdown](zernio-feature-plan.md) defines status and acceptance rules; the [operation inventory](zernio-api-inventory.csv) lists the API surface without treating every operation as a separate user feature.

## Stores and articles

The existing router in [server/index.mjs](../server/index.mjs) and [server/integrations.mjs](../server/integrations.mjs) has no Blogs or Commerce workflow. [IntegrationSettings](../src/IntegrationSettings.tsx) maps a Zernio profile but does not provide store onboarding. A public URL attached to an ad or an asset is not store integration.

| Feature family | Current app | Required workflow |
| --- | --- | --- |
| Shopify connection | Missing | Collect store domain, start OAuth or accept the supported Admin token securely; verify the returned account belongs to this project. Reconnection must preserve identity. [Shopify](https://docs.zernio.com/platforms/shopify) |
| WordPress connection | Missing | WordPress.com selection or self-hosted HTTPS site/Application Password flow, verified site scope, reconnect and disconnect. [WordPress](https://docs.zernio.com/platforms/wordpress) |
| Blogs and articles | Missing | Blog selection/management where supported; draft, preview, schedule, update and delete articles with title, body, author, tags, image and platform-supported metadata. Do not put store accounts in the social post selector. [Blogs](https://docs.zernio.com/blogs/list-blogs) |
| Store permissions | Missing | Read store capabilities and missing grants before rendering controls; provide a deliberate merchant permission handoff. Recheck after reconnect or grant changes. [Store capabilities](https://docs.zernio.com/commerce/get-commerce-store) |
| Products | Missing | Search/paginate, view, draft/create, edit, duplicate, change state and bulk tags. Give partial bulk outcomes per product. Keep decimal store amounts and currency intact. [Product creation](https://docs.zernio.com/commerce/create-commerce-product) |
| Variants, images and options | Missing | Manage variant combinations/prices, option axes and ordered images; distinguish pending remote image processing from completion. [Commerce](https://docs.zernio.com/guides/commerce) |
| Stock | Missing | Choose location and variant, show existing levels, then set/adjust stock with readback and concurrency handling. [Stock](https://docs.zernio.com/commerce/list-commerce-inventory) |
| Collections | Missing | Browse/create/edit collections, manage membership, ordering and supported publication controls. [Commerce](https://docs.zernio.com/guides/commerce) |
| Discounts | Missing | Code/automatic discounts where supported, eligibility, values, dates, activation and code management. Capability-specific forms must distinguish coupons from automatic discounts. [Discounts](https://docs.zernio.com/commerce/create-commerce-discount) |
| Sales channels and market pricing | Missing | Supported product/collection publication, markets and fixed price lists, with currency and platform limits. [Commerce](https://docs.zernio.com/guides/commerce) |
| Custom store content | Missing | Supported product/collection metafields, metaobjects, pages, menus and redirects. Use resource-specific editors and deletion confirmations. [Commerce](https://docs.zernio.com/guides/commerce) |
| Store-to-Meta catalog sync | Missing | Select a store, Meta connection and catalog; create/list/run/stop syncs; show counts, rejected items and last result. Stopping a sync must explain retained catalog items. [Catalog sync](https://docs.zernio.com/commerce/create-commerce-catalog-sync) |
| Store marketing attribution | Missing | Link a campaign activity by stable remote ID and report its daily engagement; keep store attribution distinct from local link-request counts. [Marketing activities](https://docs.zernio.com/commerce/upsert-commerce-marketing-activity) |
| Legacy Products API | Do not build a second editor | New implementation uses Commerce; retain compatibility only if a real existing integration needs a deprecated route. [Shopify deprecation](https://docs.zernio.com/platforms/shopify) |

Shopify and WooCommerce do not expose identical operations. The current guide supports WooCommerce through self-hosted WordPress, while some reference badges remain narrower. Read the connected store's actual capabilities; do not infer capability from a platform name. Store content publishing is in scope here; organic search reporting remains in ten98 Discover. [Commerce differences](https://docs.zernio.com/guides/commerce)

Acceptance: scoped connection and pagination, draft creation, publication/scheduling readback, stale edits, revoked grants, unsupported fields, partial bulk failure and an accepted-but-unreadable write must each have a runnable check. Real store writes have no assumed sandbox: automated acceptance uses synthetic fixtures; any live write needs an explicitly designated test store.

## Provider administration and diagnostics

Local application users, invitations, roles and OIDC already exist. They authorize access to this app; they are not Zernio team membership or Zernio enterprise SSO. New provider administration belongs to instance operators with workspace administration, not ordinary campaign editors.

| Feature family | Current app | Required workflow |
| --- | --- | --- |
| Provider identity and members | Missing provider view | Read Zernio team identity/profile access without conflating it with local members. [Users](https://docs.zernio.com/users/list-users) |
| Zernio team invitations | Missing | Separate provider invite flow with explicit permission impact; keep existing local invitations unchanged. [Provider invites](https://docs.zernio.com/invites/create-invite-token) |
| Provider API keys | Partial | Encrypted configured-key storage/testing exists; listing, restricted-key creation, expiry and revocation are missing. Show newly issued secrets once and never put them in receipts or logs. [Keys](https://docs.zernio.com/api-keys/create-api-key) |
| Authorized provider apps | Missing | List and explicitly revoke Zernio OAuth clients without logging out local users. [Connected apps](https://docs.zernio.com/connected-apps/list-connected-apps) |
| Provider usage and billing | Missing | Operator-only usage, quota, spend and billing-status reads, separate from ad spend and OpenRouter usage. Link to provider payment setup; never silently purchase capacity. [Usage](https://docs.zernio.com/usage/get-usage), [billing](https://docs.zernio.com/usage/get-billing) |
| Provider activity logs | Missing | Filter/page provider logs, retain sanitized request IDs, distinguish local receipts from upstream diagnostics. [Logs](https://docs.zernio.com/logs/list-logs) |
| Support Assistant | Missing | Optional explicit paid question, cost cap, retained key, asynchronous result/thread and fallback polling. Scope the result for operators: provider support can cover the entire team. This is separate from the existing OpenRouter drafting assistant. [Support](https://docs.zernio.com/support-assistant) |
| Structured feedback | Missing | Reviewable diagnostic submission with explicit send action and no credentials/private payload dump. [Feedback](https://docs.zernio.com/feedback/submit-feedback) |
| API change tracking | Missing | Read versioned changes and classify affected capabilities/tests; webhook handling should flag breaking changes for an operator. [Changelog](https://docs.zernio.com/changelog/list-changelog) |
| Zernio SSO/SCIM/MFA | Provider-managed | Zernio's enterprise identity setup has its own agreement and owner/DNS steps. No public `/v1` management contract was found in the pinned inventory; provide the provider handoff rather than imitate private dashboard APIs. This app keeps its local/OIDC login. [Zernio SSO](https://docs.zernio.com/security/sso) |

Acceptance: operator versus editor/viewer access; full versus restricted/profile-scoped keys; revoked credentials; pagination; safe secret display; usage unavailable/zero states; and support-run retries without a second charge. Provider grants or revocations must be deliberate user actions.

## Additional Zernio communication products

[server/inbox.mjs](../server/inbox.mjs) already recognizes `imessage`, `rcs` and `sms` for basic provider conversations. That is partial support, not sender provisioning or a full campaign editor. Local [SMS campaigns](../server/direct-providers.mjs) use Twilio and remain available.

| Product | Current app | Work required for full supported coverage |
| --- | --- | --- |
| Zernio SMS/MMS | Partial inbox adapter; no Zernio campaign provider | Add selectable Zernio transport alongside Twilio, sender eligibility, media, recipient lookup, opt-outs and US registration/preflight/review states. Consent/suppression must apply across transports. [SMS](https://docs.zernio.com/platforms/sms) |
| Phone numbers | Missing | Browse inventory/capabilities, purchase or port, KYC/document review, remediation, stock watches, enable SMS/WhatsApp and release. Prices and irreversible/provider-billed actions need explicit review. Voice controls stay excluded. [Numbers](https://docs.zernio.com/platforms/phone-numbers) |
| RCS | Partial basic inbox; no campaign/agent lifecycle | Brand and agent setup, carrier review/test/launch, approved assets, device capability check, rich cards/carousels/buttons, receipts and deliberate SMS fallback. Never present an unapproved agent as live. [RCS](https://docs.zernio.com/platforms/rcs) |
| iMessage | Partial basic inbox; no sender/campaign lifecycle | Sender management, audience/opt-in links, supported new-contact rules, rich actions, edit/unsend, groups and channel fallback. Eligibility and warm-up are provider constraints, not bypassable UI options. [iMessage](https://docs.zernio.com/platforms/imessage) |
| Verify OTP | Missing | Explicit phone-verification service with expiry, attempt/abuse limits and webhook outcomes. Verification does not grant marketing consent. [Verify](https://docs.zernio.com/verify/create-verification) |
| PSTN/WhatsApp calls, softphone, recordings, SIP and branded calling | Excluded by earlier user instruction | Inventory the APIs for completeness, but do not enable a calling module or voice campaigns unless the user reverses that instruction. Number provisioning can still carry upstream voice capability; the app must not place calls. |

No new native integration is required for these documented Zernio operations. Provider approval, carrier review, merchant terms, KYC and payment setup still need the relevant human/account flow. Credentials alone are not activation evidence.

Acceptance: inbound attribution, original sender on replies, consent/STOP across fallback channels, media validation, duplicate callbacks, failed/uncertain sends, carrier-state transitions, scope isolation and sender cancellation. A fallback cannot silently turn one intended message into two sends.
