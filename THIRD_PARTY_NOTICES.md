# Third-party notices

ten98 Campaign's original application code is available under the [MIT license](LICENSE), copyright (c) 2026 ten98-campaign contributors. Third-party components retain their own copyright and license terms.

## Reference applications

The following projects inform the advertising and unified inbox (messages, comments and reviews) workflows. The inbox was removed in version 0.4.0 and later restored, so both credits are current:

- [zernio-dev/ads-dashboard](https://github.com/zernio-dev/ads-dashboard) at commit [4386edd](https://github.com/zernio-dev/ads-dashboard/tree/4386eddc9a35c2b93c392d8523d148b0f95a62eb), copyright (c) 2026 Zernio — [MIT license](https://github.com/zernio-dev/ads-dashboard/blob/4386eddc9a35c2b93c392d8523d148b0f95a62eb/LICENSE).
- [zernio-dev/unified-inbox](https://github.com/zernio-dev/unified-inbox) at commit [3d62be1](https://github.com/zernio-dev/unified-inbox/tree/3d62be18923df6fa22fa01037a2057254553206d), copyright (c) 2026 Zernio — [MIT license](https://github.com/zernio-dev/unified-inbox/blob/3d62be18923df6fa22fa01037a2057254553206d/LICENSE).

The publishing/scheduling and content-approval workflows are compared against these references (ten98-code-system#29):

- [zernio-dev/latewiz](https://github.com/zernio-dev/latewiz) at commit [28dd018](https://github.com/zernio-dev/latewiz/tree/28dd018063b955769de11f881acd03bb64c61cd4), copyright (c) 2024 Late — [MIT license](https://github.com/zernio-dev/latewiz/blob/28dd018063b955769de11f881acd03bb64c61cd4/LICENSE). Publishing and scheduling. It needs a Zernio key to run, so Campaign compares it at source level only.
- [pendpost/pendpost](https://github.com/pendpost/pendpost) at commit [42ac77b](https://github.com/pendpost/pendpost/tree/42ac77b29f7720a912bdce1507b16a2a56fca74f), copyright (c) 2026 Nomadik GmbH — [MIT license](https://github.com/pendpost/pendpost/blob/42ac77b29f7720a912bdce1507b16a2a56fca74f/LICENSE). Content approvals. Disclosed differences, not parity:
  - Editing an approved post keeps it approved in pendpost. It sets `editedSinceApproval`, and the scheduler skips flagged posts. Campaign instead invalidates the review when a post or its referenced asset changes.
  - Pendpost's "no self-approval" rule compares a caller-supplied string, so it is a user-experience rule, not authorization. Campaign keeps its own server-side role and membership authorization for reviews.
  - Pendpost exempts a role (`owner`) from its self-approval rule. Campaign exempts by count instead: a requester may approve their own request only when the project has exactly one active owner or administrator, and that review is recorded as self-approved (council decision ten98-code-system#30).

Team-inbox triage state (waiting since, first reply, status, snooze and assignment; ten98-campaign#41) follows this reference:

- [chatwoot/chatwoot](https://github.com/chatwoot/chatwoot) at commit [a8487ab](https://github.com/chatwoot/chatwoot/tree/a8487abf5c5b54960f2375e8c613fe72711077fa), copyright (c) 2017-2026 Chatwoot Inc. — [MIT license](https://github.com/chatwoot/chatwoot/blob/a8487abf5c5b54960f2375e8c613fe72711077fa/LICENSE), excluding `enterprise/`, which has its own licence and is not used. This is a behaviour port only; no source is copied.

Campaign ports selected behaviour from these references, adapted to its own stack. Each ported helper carries a provenance comment naming the reference, commit and file; whole source files are not copied. Zernio calls are implemented independently with Node.js built-ins and `fetch`. The workspace/project hierarchy and purple visual palette also follow the local ten98-monitor project (MIT, copyright 2026 ten98-monitor contributors), inspected as reference rather than copied source.

## Direct dependencies

| Component | Version | License |
| --- | --- | --- |
| React and React DOM | 19.2.8 | MIT; Meta Platforms, Inc. and affiliates. |
| openid-client | 6.8.8 | MIT; Filip Skokan. |
| pg (node-postgres) | 8.23.0 | MIT; Brian Carlson. |
| qrcode-generator | 2.0.4 | MIT; Kazuhiko Arase. |
| drizzle-orm | 0.45.2 | Apache-2.0; Drizzle Team. |
| @types/node | 24.10.1 | MIT; DefinitelyTyped contributors. |
| @types/pg | 8.15.6 | MIT; DefinitelyTyped contributors. |
| Vite | 8.3.4 | MIT. |
| TypeScript | 7.0.2 | Apache-2.0. |
| @types/react | 19.2.2 | MIT; DefinitelyTyped contributors. |
| @types/react-dom | 19.2.2 | MIT; DefinitelyTyped contributors. |

The lockfile records resolved direct/transitive packages and their license metadata. The distributed packages' license and notice files remain authoritative; retain them when redistributing dependencies. Node.js and the Docker base image have their own included licenses.

## External services and API contracts

These integrations use remote services with separate account access, billing, content rights, and service terms. This repository's MIT license does not license those services, model weights, uploaded media, or provider trademarks.

- **Zernio:** [API documentation](https://docs.zernio.com/), [ad creation](https://docs.zernio.com/ad-campaigns/create-standalone-ad), and [webhook contracts](https://docs.zernio.com/webhooks). Social composition, publishing/lifecycle, restriction preflight, advertising, and analytics requests go through Zernio. Platform permissions and available endpoints determine coverage. Direct messaging and comment/review feeds are no longer part of this application.
- **Broadsign:** [API-key authentication](https://docs.broadsign.com/broadsign-platform/en/Documentation_Settings/settings-api-keys.html) and [Guaranteed Campaigns workflow](https://docs.broadsign.com/broadsign-platform/en/Documentation_Gteed_Campaigns/g-c-new-campaign-rest.html). The application implements REST inventory, proposal, booking, cancellation, and delivery calls without embedding a Broadsign SDK. Creative bundles are managed in [Broadsign's separate application](https://app.broadsign.com/campaigns), under the provider's own permissions and terms; cancellation does not establish refunds.
- **Google:** [Drive API](https://developers.google.com/workspace/drive/api/guides/about-sdk), [Calendar API](https://developers.google.com/workspace/calendar/api/guides/create-events), and [service-account authorization](https://developers.google.com/identity/protocols/oauth2/service-account). [Maps JavaScript API](https://developers.google.com/maps/documentation/javascript) loads Google's code from its servers when enabled; its API key is intentionally browser-visible and should use [Google's restrictions](https://developers.google.com/maps/api-security-best-practices).
- **OpenRouter:** [tool calling](https://openrouter.ai/docs/guides/features/tool-calling) and [usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting). Orchestration runs locally; model requests are sent to OpenRouter and its selected model provider.

Provider documentation is referenced for contracts; it is not bundled as application source. No provider credentials or customer media are included in this repository.

The 0.3 integration settings, encryption, invitations, content approval, and operation-review workflows and the 0.4 per-platform composer use the application's existing dependencies and Node.js built-ins. They introduce no additional third-party SDK or license requirement. Platform option schemas are derived from the publicly documented Zernio API contract. Connection tests contact the configured provider explicitly; OpenRouter's test reads key metadata without requesting model inference, and Maps verification loads Google's browser service.
