# Shared architecture

Read the installed `node_modules/@ten98/runtime/README.md` and `architecture.json` before changing shared technical behavior or dependencies. The maintained source is [ten98-code-system](https://github.com/Ten98-IO-Company/ten98-code-system).

Reuse @ten98/runtime for common server primitives and @ten98/ui for presentation. Keep native authorization and paid-operation safeguards. Trace all callers before replacing duplicated code. Run the app's architecture, test and build checks. Preserve unrelated edits and immutable vendor releases.

# Documentation

Write documentation to the wiki (https://github.com/Ten98-IO-Company/ten98-campaign/wiki), not docs/; keep inline code comments in code.

Same feature, same experience: the same features across both apps should look the same and work the same. Build a feature that Campaign and Discover share from the same @ten98/ui components, wording, steps and behaviour, and before approving a UI change compare it with the other app's equivalent (https://github.com/Ten98-IO-Company/ten98-campaign/wiki/Development#same-feature-same-experience).
