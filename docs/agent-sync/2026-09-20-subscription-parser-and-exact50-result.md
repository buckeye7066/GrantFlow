# Subscription parser repair and completed exact-50 result

## Changed
The native Codex parser accepts completed reasoning records as non-output metadata and extracts only completed agent messages. Tool events, failed or unknown records, missing terminal completion, invalid usage and output-size violations remain rejected. Authentication, CLI permissions, owner scoping, billing fallback and customer behavior are unchanged.

The shared parser feeds both the local operator acceptance command and the hosted bridge worker through executeJob. Their result contracts are unchanged. A failing-first regression proves that valid reasoning records no longer discard the final answer or trigger the secondary provider. All 48 owner-AI tests passed locally; full-suite and release evidence belong on the PR.

## Canonical benchmark result: failed, not pending
Run finishline-exact50-20260920T042251Z completed on 2026-09-20 at 16:39:19 UTC, status failed, exit code 4. Its immutable tested source was b3e8240a93299771f2ba9002bef682799b49e359. The original receipt is preserved in the GrantFlow-release-20260919 worktree under audit-reports/finishline-exact50-20260920T042251Z.json.

Exactly 50 profiles were planned, created and crawled. Amy evaluated 19, reported 31 unevaluable from degraded providers, and recorded zero clean profiles. Discovery fetched 2083 pages, extracted 733 candidates and stored 650 rows; these activity counts do not prove qualified matches. All 50 members were scored for web parity, but quality requirements failed and fleet parity measured zero against the unchanged owner-approved threshold of 100. Qualification was not proven.

Native inference recorded subscription:codex and subscription billing, with 1591 completed calls, 132 failures and 138 aborts. This proves local subscription execution, not successful qualification or hosted owner activation. Search provenance included 45 degraded discovery queries and 33 degraded parity queries.

Fresh temporary SQLite, all 200 migrations, deletion of the 50 temporary profiles and removal of the temporary directory were verified. Production data, outbound email and live schedulers were not used. The parser change is not claimed to repair every benchmark failure; no acceptance rule was lowered and no new benchmark pass is claimed.

## Separate ForgePress release state
Owner text-entry, output metadata, context preservation, native response parsing and renderer-lifetime repairs are pushed on ForgePress PR125 at 1747573493504dadc4f9b8dabbf31a2841c1143b. Its 37 related tests, full suite, audit, Windows package and ordinary isolated packaged launch passed. Owner mode was disabled in that launch. The queue cancellation-capacity issue and live owner-mode acceptance remain unresolved after tool-denied operations; do not retry denied operations through another path or describe the installed application as updated.
