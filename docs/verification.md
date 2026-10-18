# End-to-end verification — v0.4.1

Verified on 18 October 2026 with the production frontend, actual local HTTP server, isolated database and synthetic accounts. Provider mocks blocked external API calls and recorded requests. Existing user data and credentials were not used for tests.

## Five-area browser walkthrough

| Area | Verified workflow |
| --- | --- |
| Ads manager | Connected Meta/native account selection; create a paused image campaign; load campaign spend/impressions; scoped ad details; edit and read back a headline; pause an ad; rename an ad set and change its daily budget with provider confirmation. |
| Social publishing | Select Instagram/Facebook accounts; attach approved Drive-backed artwork and a campaign; separate Instagram caption/first comment; shared Facebook copy; effective previews and preflight; require approval, request review and approve; explicitly schedule at 10:30 Dubai time and verify `2026-11-04T06:30:00.000Z` in the provider request. |
| Analytics | Load the requested reporting window; verify impressions, reach, followers, engagement, daily chart and post metrics against the fixture. Missing local campaign metrics remain unknown; explicit zeros are preserved. |
| OOH | Approve domain/client/screen scope; sync inventory and coordinates; save a proposal; use the provider-calculated quote; check availability; explicitly approve booking; refresh exact line-item delivery totals; request cancellation, retain its pending state, then reconcile confirmed cancellation into the shared plan. |
| Drive DAM | Sync original links and thumbnails; upload a document; edit public delivery media, tags and description; approve artwork; repeat sync without duplicates; preserve unchanged approvals; reset approval when source metadata changes; reuse the asset and description/alt text in social publishing. Invalid provider metadata leaves assets unchanged. |

Read-only checks of the recorded requests and isolated database verified the same results, including one uploaded document, exact caption/options/alt-text payloads, UTC scheduling, approved review state, ad-set budget/name changes, and cancelled provider placements. No real ad activation, booking, upload or social publication occurred.

![Ads manager](ads-verification.png)

![Social publishing with approved DAM media](social-verification.png)

![Analytics](analytics-verification.png)

![OOH proposal, delivery totals and confirmed cancellation](ooh-verification.png)

![Google Drive DAM](dam-verification.png)

## Runnable checks

Run `npm run build` and `npm test`. All 65 native Node checks pass. Temporary HTTP servers/databases, provider mocks and actual frontend handlers cover authentication/OIDC, roles, invitations, encrypted integration settings, calendar/maps behavior, provider recovery, approvals and the five areas above.

The ads HTTP check creates 20 supported format combinations: Meta image/video/carousel, Google Search/Display/Performance Max and Demand Gen variants, LinkedIn image/video, TikTok video, Pinterest image, X cards, ChatGPT cards, and Reddit image/video/carousel/text. It also checks creative/status/budget changes, supported renames, partial-post boosts, malformed acknowledgements, date handling, isolation and connection races.

Drive checks cover concurrent imports, repeated IDs and pages, incomplete/malformed responses, atomic rollback, media metadata, preserved manual fields/approvals, GIF restrictions, alt text, uploads and uncertain acknowledgements. OOH checks include inclusive date limits, inventory normalization, idempotency, booking/delivery/cancellation, stale-report races and confirmed-write refresh recovery. Social checks cover per-platform persistence, immediate publishing/scheduling/updates/retries, all creative references, approval invalidation, creator permissions and stale UI recovery. Analytics checks cover inclusive reporting windows, numeric/null/zero values and foreign or malformed rows. Project-change checks prevent delayed uploads or old callbacks from starting writes in a former project.

## Fixes completed

- Ad lists enforce the selected campaign/network locally; successful copies of partially delivered social posts can be boosted after fresh account checks.
- Google advertising dates preserve the account's calendar date, including single-day campaigns. Unsupported renames and Smart+ creative edits fail before provider writes; Display creative editing is exposed.
- Create/boost and mutation acknowledgements validate identity, scope and confirmation. A failed details refresh after a confirmed write cannot encourage another edit until refreshed.
- Approval results and initial provider-status refreshes update the UI correctly. Missing local metrics no longer appear as fabricated zero values or invalid ratios.
- OOH screens use normalized IDs, date windows are inclusive, and stale reads cannot overwrite cancellation receipts. Confirmed actions with failed follow-up loading require an explicit refresh before further changes.
- Drive metadata is validated before atomic imports, deduplicated and retained for publishing restrictions. GIF and alt-text handling are consistent with the asset library.

## Live account acceptance

No real provider credentials were supplied for these tests. Live Zernio delivery, ad permissions/spend, Google Drive/Shared Drive access, Google Maps rendering with a billed/referrer-restricted key, public HTTPS webhooks, and Broadsign account behavior require acceptance with the operator's configured accounts. Google Maps coordinates and loader behavior were checked; a real Google map render was not claimed without a key. Provider-specific creative trafficking and unsupported native controls remain the documented dashboard workflows in the README.
