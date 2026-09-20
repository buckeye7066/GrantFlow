# Canonical acceptance with the operator's ChatGPT subscription

The canonical fifty-profile CLI accepts an explicit Windows operator option, --subscription=codex. The existing official client must prove ChatGPT authentication before execution. It uses the existing local user's dedicated Codex profile, not an API key, a shared credential, an enrolled hosted worker, or a fabricated synthetic owner identity.

The new process-local context exists only during that explicit canonical CLI operation. It cannot activate in the production server and becomes unusable after its callback ends. Native failures, cancellation, invalid JSON, incomplete output or wrong provider metadata fail closed without a paid or free-model retry. The selected provider and completed/failed call counts are recorded in the acceptance receipt. Ordinary application provider selection is unchanged.

Native authentication and execution remain CLI-only dependencies under tools/owner-ai. The backend imports only a dormant context holder. No Dockerfile runtime whitelist, security baseline, customer authorization, stored credential or deployment variable was changed.

The exact cohort of fifty, independent web-parity comparison, owner-approved threshold, source-SHA/clean-worktree proof, fresh temporary SQLite migrations, evidence validation, and canonical cleanup are unchanged. No discovered funding or acceptance verdict is fabricated. Subscription execution is not itself a passing benchmark.

Verification before commit: the new tests failed on absent implementation and the lifetime regression failed on a retained context, then passed after their repairs. The related six-file suite passed 101 tests. Native CLI, bridge and acceptance isolation regressions passed 35 tests. Full check:prepush passed, including runtime-import guard, lint, typecheck, secret scan and production build.

Usage from a clean immutable checkout:

    node scripts/grantflow-acceptance-50.mjs --expected-sha=<exact-40hex> --output=audit-reports/<new-receipt>.json --allowed-providers=searxng --subscription=codex

Use the existing search service and a process environment without production DB/email or paid-model credentials. Some existing SearXNG upstream engines currently report rate limits/CAPTCHA; HTTP 200 alone does not prove search quality. A real terminal receipt, not a small native diagnostic, must establish fifty-profile acceptance.

ForgePress remains separately unfinished. Its previously denied renderer-test operation was not repeated or recreated through another tool during this continuation.
