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

`origin/main` does **not** contain the option-4 apply-path
(`_apply_named_return_statement`, purpose-fit reject flip, stale/style
certifier drops, already-satisfied ledger + fix-stream drops). Those live
only on this VM: `/home/ubuntu/flexfactor` branch
`cursor/pr110-ci-wire-a427` tip **`462fb37`**.

GrantFlow-scoped `gh` still has `permissions.push=false` on
`buckeye7066/flexfactor`. Do not loop Contents PUT / fork / push.

## Local option-4 apply-path

Portable patch: `docs/agent-sync/flexfactor-pr110-landing.patch`.
One-shot: `scripts/land-flexfactor-pr110.sh` (exits 3 if no write).
Target a **new** branch off `origin/main`, not #110.

| SHA | What |
|---|---|
| `06c7d10` | CI wire (already on main via #110) |
| `7aab5ec`…`084af84` | apply-path / phase-0 honesty / test-weaken rollback |
| `e8685f7` | unmapped competitor ACCEPT → purpose-fit reject; stale certifier drop |
| `596b4a8` | drop SyntaxError + baseline-checkout claims on a compiling file |
| `478205b` | drop already-satisfied findings from the unresolved ledger |
| **`462fb37`** | **same drop BEFORE `_fix_files` generation** — change X to X no longer enters `[edit-fallback]` / 15-min whole-file regen |

Cherry-pick `7aab5ec^..462fb37` (skip `06c7d10` if it conflicts as already landed).

## Option 4 in flight (do not restart these)

| Fixture | Engine | Result |
|---|---|---|
| `/tmp/ff-option4-keep` | `084af84` | EXIT 1 — pandas ACCEPT + stale `a - b` in reproduction |
| `/tmp/ff-option4-close` | `e8685f7` | EXIT 1 — invented SyntaxError + baseline checkout |
| `/tmp/ff-option4-cert` | `596b4a8` | EXIT 1 — ledger kept change X to X |
| `/tmp/ff-option4-done` | `478205b` | **killed** — hung 15 min on whole-file regen of already-correct `hello.py` after `[edit-fallback]` |

**Current run:** `/tmp/ff-option4-skip` log `/tmp/ff-option4-skip.log`
engine **`462fb37`**. Planted `add() = a - b`, both tests, owner-authored
`docs/purpose-contract.md`. Do not treat mid-run as EXIT 0. Prove
`hello.py` is `a + b`, `test_greet` present, **and** factory `EXIT:0`.

Ollama: `qwen2.5-coder:3b` (free). Do not spend money on paid models.

Closed classes (do not re-diagnose): pandas unmapped ACCEPT, stale `a - b`
in reproduction, SyntaxError+baseline-checkout, change X to X in the
ledger, change X to X entering whole-file regen.

## PromoPilot (remeasured 2026-09-01T23:51Z)

Live SHA still `b68d809`. `/healthz` live; scheduler+publishing enabled.
`/readyz` ready. Portfolio **ARMED** / live / daily cap 2.
`armed_at` 2026-09-01T12:52:39Z. `killed_at` 2026-08-06T15:42:36Z.
Calendar days **0**. Open drafts **0**. Newest recent post still
2026-08-06T20:21:12Z Mastodon **failed** (`login is currently disabled`).
`buckeye7066/promopilot` still 404. This token cannot write it.
Do not dest-approve Mastodon. Do not publish.

## What the next FlexFactor-writable agent must do

1. Branch from `origin/main` (`3b6760d`), **not** from #110.
2. Cherry-pick `7aab5ec^..462fb37` from `/home/ubuntu/flexfactor`
   (skip `06c7d10` — already on main) or apply the patch.
3. Open a new PR. Wait for exact-head production-readiness green on
   both OS, then merge.
4. Do not force-push `main`.
