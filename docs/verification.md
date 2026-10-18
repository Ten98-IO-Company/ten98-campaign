# End-to-end verification — v0.3.1

Verified on 18 October 2026 using an isolated local database and synthetic accounts. Existing user records and credentials were not changed.

## Browser walkthrough

The production frontend was exercised against the actual local HTTP server. Provider interactions used a local fetch mock that blocked external calls.

| Workflow | Result |
| --- | --- |
| Local sign-in and project navigation | Passed |
| Campaign creation with budget and dates | Passed |
| Asset creation, metadata, approval and real-media fallback | Passed |
| Social draft with campaign, artwork and planned time | Passed |
| Request review, review note and approval | Passed |
| Submit schedule and return provider post to an unpublished draft | Passed with mocked Zernio |
| Create Meta carousel and view its paused campaign/ad details | Passed with mocked Zernio |
| Sync inbox, read thread, send reply, resolve and reopen | Passed with mocked Zernio |
| Media partner and OOH booking with coordinates | Passed |
| Integration status and explicit Zernio connection test feedback | Passed with mocked Zernio |
| Create separate project, rename and switch back | Passed; records and settings remained scoped |
| Sample cleanup control | Displayed only for project administrators; deletion, dependency conflicts and preservation are covered by HTTP checks |

## Runnable checks

Run `npm run build` and `npm test`. The release has 40 native checks, including temporary HTTP servers, provider mocks and actual frontend handler logic. They cover auth/OIDC/invitations, role boundaries, encrypted settings and connection probes, Drive/Calendar/Maps, approvals, social lifecycle, ad formats, signed webhook routing/replay/restarts, engagement replies, OOH proposals/cancellation, AI usage recovery, and record lifecycle.

New regressions cover stale Calendar views, preserved mapping edits, uncertain AI request warnings, native/webhook message identity and edits, delivery receipts and deletion, inbox scope/acknowledgements, sample cleanup, clearing publishing destinations, date-only timezone behavior, upcoming work, and safe preview fallbacks.

## Live acceptance

No real Zernio, OpenRouter, Google, Broadsign or OIDC credentials were supplied for this verification. Live provider delivery, account permissions, Google Maps billing/referrer restrictions, webhook delivery over public HTTPS, and identity-provider configuration still require account-level acceptance. Passing mocks does not establish that external setup. Provider coverage and the release's explicit limits remain documented in the README.
