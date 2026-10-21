# Contributing

Use Node.js 24, run `npm ci`, then `npm run dev`. Verify changes with `npm run build` and `npm test` before opening a pull request. The suite runs on PostgreSQL: set `TEST_DATABASE_URL` to a disposable server whose role may create databases (each test file clones its own database from a migrated template), for example `docker run -d --name campaign-test-pg -e POSTGRES_PASSWORD=test -p 127.0.0.1:55432:5432 postgres:18` with `TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/postgres`. Without it, database tests are skipped locally; CI always runs them.

Keep `main` and `dev` as the two permanent branches. Start each feature on a temporary `codex/` branch from the updated `dev` branch and merge its tested pull request into `dev`. Promote `dev` to `main` through a pull request, then fast-forward `dev` to the merge result so both branches stay synchronized. Tag and release the promoted `main` commit. Delete the merged feature branch; keep `dev`.

Keep changes focused. Reuse the existing provider helpers and native platform features before adding dependencies. Every nontrivial behavior change needs a small runnable regression check. Provider tests must use mocks, never real spending or credentials.

Trace every caller when fixing shared behavior. Review asynchronous results for project changes, unmounted editors, concurrent updates and uncertain provider writes. Remove unused code only after checking its callers; keep validation, consent and access controls intact.

After changing Docker packaging or runtime imports, verify the actual image:

```sh
docker build -t ten98-campaign:check .
docker network create campaign-check
docker run -d --name campaign-check-pg --network campaign-check -e POSTGRES_PASSWORD=check postgres:18
docker run --rm -i --network campaign-check -e DATABASE_URL=postgres://postgres:check@campaign-check-pg:5432/postgres --entrypoint node ten98-campaign:check --input-type=module < scripts/check-container.mjs
docker rm -f campaign-check-pg && docker network rm campaign-check
```

In PowerShell, pipe `Get-Content -Raw scripts/check-container.mjs` to the same `docker run` command instead of using `<`. The check migrates the empty database it is given, uses a temporary data directory, and makes no external requests; the private network reaches only that database.

Enforce project membership at every server entry point. Instance-wide credentials and provider mappings require instance operator authority in addition to workspace administration. Treat inbox messages, provider data, and AI output as untrusted input. Never put keys, `.env`, databases, customer conversations, or production logs in a commit or issue.

Contributions are distributed under the repository’s MIT license. Preserve notices for any third-party source you reuse. Describe what changed, why, and how you verified it in your pull request.
