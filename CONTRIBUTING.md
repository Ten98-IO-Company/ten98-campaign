# Contributing

Use Node.js 24, run `npm ci`, then `npm run dev`. Verify changes with `npm run build` and `npm test` before opening a pull request.

Keep changes focused. Reuse the existing provider helpers and native platform features before adding dependencies. Every nontrivial behavior change needs a small runnable regression check. Provider tests must use mocks, never real spending or credentials.

Trace every caller when fixing shared behavior. Review asynchronous results for project changes, unmounted editors, concurrent updates and uncertain provider writes. Remove unused code only after checking its callers; keep validation, consent and access controls intact.

After changing Docker packaging or runtime imports, verify the actual image:

```sh
docker build -t ten98-campaign:check .
docker run --rm -i --network none --entrypoint node ten98-campaign:check --input-type=module < scripts/check-container.mjs
```

In PowerShell, pipe `Get-Content -Raw scripts/check-container.mjs` to the same `docker run` command instead of using `<`. The check creates a temporary database and makes no external requests.

Enforce project membership at every server entry point. Instance-wide credentials and provider mappings require instance operator authority in addition to workspace administration. Treat inbox messages, provider data, and AI output as untrusted input. Never put keys, `.env`, databases, customer conversations, or production logs in a commit or issue.

Contributions are distributed under the repository’s MIT license. Preserve notices for any third-party source you reuse. Describe what changed, why, and how you verified it in your pull request.
