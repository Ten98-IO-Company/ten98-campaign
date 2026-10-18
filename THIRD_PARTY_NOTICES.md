# Third-party notices

ten98 Campaign's original application code is available under the [MIT license](LICENSE), copyright (c) 2026 ten98-campaign contributors. Third-party components retain their own copyright and license terms.

## Reference applications

The following projects informed the advertising and messaging workflows:

- [zernio-dev/ads-dashboard](https://github.com/zernio-dev/ads-dashboard), copyright (c) 2026 Zernio — [MIT license](https://github.com/zernio-dev/ads-dashboard/blob/main/LICENSE).
- [zernio-dev/unified-inbox](https://github.com/zernio-dev/unified-inbox), copyright (c) 2026 Zernio — [MIT license](https://github.com/zernio-dev/unified-inbox/blob/main/LICENSE).

Their source files are not copied into this application. Zernio calls are implemented independently with Node.js built-ins and `fetch`. The workspace/project hierarchy and purple visual palette also follow the local ten98-monitor project (MIT, copyright 2026 ten98-monitor contributors), inspected as reference rather than copied source.

## Direct dependencies

| Component | Version | License |
| --- | --- | --- |
| React and React DOM | 19.2.8 | MIT; Meta Platforms, Inc. and affiliates. |
| openid-client | 6.8.8 | MIT; Filip Skokan. |
| Vite | 8.3.4 | MIT. |
| TypeScript | 7.0.2 | Apache-2.0. |
| @types/react | 19.2.2 | MIT; DefinitelyTyped contributors. |
| @types/react-dom | 19.2.2 | MIT; DefinitelyTyped contributors. |

The lockfile records resolved direct/transitive packages and their license metadata. The distributed packages' license and notice files remain authoritative; retain them when redistributing dependencies. Node.js and the Docker base image have their own included licenses.

## External services and API contracts

These integrations use remote services with separate account access, billing, content rights, and service terms. This repository's MIT license does not license those services, model weights, uploaded media, or provider trademarks.

- **Zernio:** [API documentation](https://docs.zernio.com/), [ad creation](https://docs.zernio.com/ad-campaigns/create-standalone-ad), and [webhook contracts](https://docs.zernio.com/webhooks). Social, advertising, messaging, and analytics requests go through Zernio.
- **Broadsign:** [API-key authentication](https://docs.broadsign.com/broadsign-platform/en/Documentation_Settings/settings-api-keys.html) and [Guaranteed Campaigns workflow](https://docs.broadsign.com/broadsign-platform/en/Documentation_Gteed_Campaigns/g-c-new-campaign-rest.html). The application implements the REST calls without embedding a Broadsign SDK.
- **Google:** [Drive API](https://developers.google.com/workspace/drive/api/guides/about-sdk), [Calendar API](https://developers.google.com/workspace/calendar/api/guides/create-events), and [service-account authorization](https://developers.google.com/identity/protocols/oauth2/service-account). [Maps JavaScript API](https://developers.google.com/maps/documentation/javascript) loads Google's code from its servers when enabled; its API key is intentionally browser-visible and should use [Google's restrictions](https://developers.google.com/maps/api-security-best-practices).
- **OpenRouter:** [tool calling](https://openrouter.ai/docs/guides/features/tool-calling) and [usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting). Orchestration runs locally; model requests are sent to OpenRouter and its selected model provider.

Provider documentation is referenced for contracts; it is not bundled as application source. No provider credentials or customer media are included in this repository.
