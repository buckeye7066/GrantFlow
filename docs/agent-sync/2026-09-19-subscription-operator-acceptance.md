# Canonical acceptance with the operator's ChatGPT subscription

## Directives
Use the owner's verified ChatGPT client for an explicitly selected local benchmark. Keep customer billing, production authentication, the fifty-profile cohort, matching rules, independent parity, strict temporary SQLite isolation and cleanup unchanged. Never turn an API request into subscription usage by relabeling it.

## Shipped work
PR1769 is merged separately at fa66b86. The work described below is on PR1770 and is not a declaration that its benchmark passed or that this branch is merged.

## In-flight work
The canonical CLI supports --subscription=codex. The official client must verify ChatGPT sign-in. Its asynchronous context is local-operation scoped, unavailable to production server requests and revoked when the operation ends. Native failures never fall through to a paid API or a free-model route. The receipt identifies the selected provider and actual completed/failed calls.

Review corrections preserve timeout/cancellation classification and route failed native sign-in into the canonical PREFLIGHT failure receipt before any database creation. The shared completion validator keeps the hard 262144-byte accepted-text limit and positive terminal usage. Codex's unenforced token hint is not proof of truncation; successful terminal completion is still mandatory. Claude's enforceable output-token budget remains unchanged.

Native authentication remains a CLI-only dependency. No runtime packaging whitelist, security baseline, credential, production variable or qualification threshold is weakened.

Usage from a clean immutable checkout:

    node scripts/grantflow-acceptance-50.mjs --expected-sha=<exact-40hex> --output=audit-reports/<new-receipt>.json --allowed-providers=searxng --subscription=codex

## Traps
The prior run subscription-exact50-20260920T033216Z was stopped after review exposed defects. It has no canonical final receipt and is not a passing benchmark. Its temporary directory was removed separately. Do not confuse that operator cleanup with canonical acceptance proof.

SearXNG can return HTTP 200 with unrelated results or unavailable upstream engines. Search health and extraction quality still require real evidence. Native sign-in or a small successful completion is not fifty-profile acceptance.

Full completion also requires ForgePress's installed interface to use its verified subscription path; that is separate from this CLI change. Evidence, test results, review findings and release state belong on the PR and the local completion record.
