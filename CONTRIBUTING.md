# Contributing

Thanks for helping improve Campaign. This file replaces the [Ten98 organisation guide](https://github.com/Ten98-IO-Company/.github/blob/main/CONTRIBUTING.md) for this repository and adds Campaign's own rules.

Setup, checks, the test database and the container check are in the wiki's [Development](https://github.com/Ten98-IO-Company/ten98-campaign/wiki/Development) page. Questions and ideas go to [Discussions](https://github.com/Ten98-IO-Company/ten98-campaign/discussions); security problems go through [SECURITY.md](SECURITY.md), not public issues.

## Pull requests

Branch from `dev` and open your pull request into `dev`; `main` receives tested releases promoted from `dev`. Run `npm run build` and `npm test` before opening it. Describe what changed, why, and how you verified it.

## Campaign rules

- The same features across both apps should look the same and work the same. Before approving a UI change, open the same feature in Discover and compare; fix differences in the same change or track them in an issue.
- Keep changes focused. Reuse the existing provider helpers and native platform features before adding dependencies.
- Every nontrivial behavior change needs a small runnable regression check. Provider tests must use mocks, never real spending or credentials.
- Trace every caller when fixing shared behavior. Review asynchronous results for project changes, unmounted editors, concurrent updates and uncertain provider writes. Remove unused code only after checking its callers; keep validation, consent and access controls intact.
- After changing Docker packaging or runtime imports, run the container check in the wiki's Development page.
- Enforce project membership at every server entry point. Instance-wide credentials and provider mappings require instance operator authority in addition to workspace administration.
- Treat inbox messages, provider data, and AI output as untrusted input.
- Never put keys, `.env`, databases, customer conversations, or production logs in a commit or issue.

## Licence and conduct

Contributions are distributed under the repository's MIT license. Preserve notices for any third-party source you reuse. By taking part, you agree to follow the [Code of Conduct](https://github.com/Ten98-IO-Company/.github/blob/main/CODE_OF_CONDUCT.md).
