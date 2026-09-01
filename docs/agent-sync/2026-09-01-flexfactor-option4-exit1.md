# 2026-09-01 — FlexFactor #110 merged; option 4 EXIT 1 remaining

Audience: next FlexFactor-writable agent, and this parent run
https://cursor.com/agents/bc-1fa35bed-bf82-42ea-9ccb-086a05522a4f

## Owner priority

FlexFactor production-ready so other apps can run through option 4
(`prodready`). PromoPilot still stalled; this token cannot write its repo.

## FlexFactor PR #110 — DONE (re-measured 2026-09-01T23:02Z)

https://github.com/buckeye7066/flexfactor/pull/110 is **MERGED**.

- Merge commit on the PR: `edfc4744a76839086f31064eebb37ff067538ddd`
  (CI wire only, parent `634250c`)
- `origin/main` now `3b6760d451fb5a2392a8d34a9c9f0603d18746b9`
  ("Autoclean verifies exact candidates and prevents behavior weakening")
- production-readiness on the merge SHA: **SUCCESS** on ubuntu, windows,
  and `package-artifact` (run 33565932180)
- rotation-extensions: **SUCCESS**
- `.github/workflows/production-readiness.yml` on main includes
  `flexfactor_autoclean_preverify_tests.py`

Do **not** re-open #110. Do **not** re-diagnose that CI failure.

## What is still NOT on origin/main

`origin/main` does **not** contain the option-4 apply-path:

- no `_apply_named_return_statement`
- no `_publication_return_pair`
- no `_independent_finding_is_style_nit`
- no purpose-fit flip of an unmapped competitor ACCEPT

Those live only on this VM: `/home/ubuntu/flexfactor` branch
`cursor/pr110-ci-wire-a427` tip **`e8685f7`**.

GrantFlow-scoped `gh` still has `permissions.push=false` on
`buckeye7066/flexfactor`. Do not loop Contents PUT / fork / push.

## Local option-4 apply-path (14 commits on top of `634250c`)

Portable patch: `docs/agent-sync/flexfactor-pr110-landing.patch`
(now 14 commits, includes `e8685f7`). One-shot apply from a writable
token should target a **new** branch off `origin/main`, not #110.

| SHA | What |
|---|---|
| `06c7d10` | CI wire (already on main via #110) |
| `7aab5ec`…`084af84` | apply-path / phase-0 honesty / test-weaken rollback |
| **`e8685f7`** | **EXIT 1 closer** — unmapped competitor ACCEPT becomes an explicit purpose-fit reject; independent final review drops `reproduction`-only stale return claims and quote/consistency nits |

## Option 4 in flight

Fixture `/tmp/ff-option4-close` planted with `add() = a - b`, both tests,
owner-authored `docs/purpose-contract.md`. Log `/tmp/ff-option4-close.log`.
Engine: `/home/ubuntu/flexfactor/flexfactor.py` at `e8685f7`.

Phase 0 already applied `[named-return]` → `return a + b`, suite GREEN,
`test_greet` still present (verified on disk mid-run). Do not treat
mid-run as EXIT 0. Prove `hello.py` is `a + b`, `test_greet` present,
**and** factory EXIT 0.

Ollama: `qwen2.5-coder:3b` (free). Do not spend money on paid models.

## PromoPilot (remeasured 2026-09-01T23:02Z)

Live SHA still `b68d809`. `/healthz` live; scheduler+publishing enabled.
`/readyz` ready. Portfolio **ARMED** / live / daily cap 2.
`armed_at` 2026-09-01T12:52:39Z. `killed_at` 2026-08-06T15:42:36Z.
Calendar days **0**. `buckeye7066/promopilot` still 404.
Do not dest-approve Mastodon. Do not publish.

## What the next FlexFactor-writable agent must do

1. Branch from `origin/main` (`3b6760d`), **not** from #110.
2. Cherry-pick `7aab5ec..e8685f7` (skip `06c7d10` — already on main)
   from `/home/ubuntu/flexfactor` if the same VM, or apply the patch
   and drop the already-landed CI-wire commit.
3. Open a new PR. Wait for exact-head production-readiness green on
   both OS, then merge.
4. Do not force-push `main`.

## Follow-up `596b4a8` (2026-09-01T23:14Z)

`/tmp/ff-option4-close` EXIT 1 only on independent-final-review:
3b cited `SyntaxError` + `git checkout` of the planted baseline after
`add()` was already `a + b` and the suite was GREEN. Product invariants
PASS. `596b4a8` drops baseline-checkout reproductions and SyntaxError
claims on a compiling file. New run: `/tmp/ff-option4-cert`.
