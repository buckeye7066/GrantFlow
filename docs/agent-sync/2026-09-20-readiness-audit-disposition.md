# GrantFlow readiness-audit disposition

## Verdict

The portfolio audit's GrantFlow limitation is a missing **passing canonical
exact-50 acceptance result**, not an unimplemented checkout, webhook, build, or
platform target. It must not be closed by relabeling smaller tests, build
artifacts, or crawler activity as workflow acceptance.

The most recent canonical run remains
`finishline-exact50-20260920T042251Z`. It failed on immutable source
`b3e8240a93299771f2ba9002bef682799b49e359`: 50 profiles were created and
crawled, 19 were evaluated, 31 were unevaluable because providers degraded,
zero were certified clean, and fleet parity was zero against the unchanged
owner-approved threshold of 100. The run cleaned its disposable database and
profiles, so it is valid failure evidence rather than a pending or abandoned
run.

## Permanent closure rule

GrantFlow may be described as certified against the requested crawler workflow
only after all of the following are true for one new canonical receipt:

1. The runner uses an immutable, clean source SHA and exactly 50 temporary
   profiles.
2. Dependency preflight proves a selected live search provider and a grounded
   extractor before creating the cohort.
3. Every cohort member is evaluated; no missing, duplicate, skipped, errored,
   or unevaluable member is counted as clean.
4. Amy reports 50 clean profiles and the independent plain-web benchmark meets
   the versioned owner policy in
   `config/web-parity-acceptance-policy.json` without lowering its threshold.
5. The receipt proves all migrations ran, the temporary SQLite database was
   used, all temporary profiles were deleted, and the temporary directory was
   removed.
6. The passing receipt is retained as immutable release evidence for the exact
   deployed revision.

The canonical command remains:

```bash
node scripts/grantflow-acceptance-50.mjs \
  --expected-sha=<exact-40hex> \
  --output=audit-reports/<new-receipt>.json \
  --allowed-providers=<configured-live-provider-list> \
  [--subscription=codex]
```

`--subscription=codex` is a local operator option and requires the official
client to be installed and signed in. It is not available merely because the
repository contains the bridge implementation. Search provider credentials are
also external runtime inputs; none may be invented, committed, or silently
replaced with degraded search results.

## Session-local verification and remaining external work

On 2026-09-20 this checkout had no edit lock, was rebased to the then-current
GitHub `main`, and the public GitHub issues endpoint returned no open issues or
pull requests. The agent environment had no authenticated GitHub CLI, no Codex
CLI, no configured search-provider credential, Node 20.20.2 rather than the
required 24.19.0, and no API extractor credential. Therefore it could not
honestly execute a new canonical run, inspect private Dependabot alerts, push or
merge a new pull request, delete remote branches, or certify cloud/local parity.

Those limitations are external state, not passing evidence. The readiness
finding remains open until the closure rule above is satisfied; do not report
this disposition note itself as a crawler fix or acceptance pass.
