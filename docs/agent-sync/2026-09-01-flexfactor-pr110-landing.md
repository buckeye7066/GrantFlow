# 2026-09-01 — FlexFactor PR #110 landing (write-blocked)

Audience: the next agent that can WRITE `buckeye7066/flexfactor`.
This GrantFlow-scoped cloud environment cannot.

Parent run: https://cursor.com/agents/bc-1fa35bed-bf82-42ea-9ccb-086a05522a4f

## Owner priority (this turn)

Get FlexFactor production-ready so other apps can be run through option 4
(`prodready`). GrantFlow individual-pipeline accuracy and PromoPilot remain
secondary.

## Exact-head facts (re-measured 2026-09-01T21:06Z)

Repo: `buckeye7066/flexfactor` (public).
PR: https://github.com/buckeye7066/flexfactor/pull/110
Branch: `fix/autoclean-verifies-what-it-commits`
Head: `634250cffd34298412cdc50fbdc3a9e96b518e35` (open, non-draft, MERGEABLE)

| Workflow | Run | Conclusion |
|---|---|---|
| production-readiness | https://github.com/buckeye7066/flexfactor/actions/runs/33547352244 | **failure** |
| rotation-extensions | https://github.com/buckeye7066/flexfactor/actions/runs/33547352204 | **success** |

The owner’s “rotation-extension lane is also not green” is **stale**.
That workflow never ran inside production-readiness because the module-list
step exits first. The dedicated `rotation-extensions` workflow is already
green on this SHA.

### The only production-readiness failure

Both `tests (ubuntu-latest)` and `tests (windows-latest)` fail at
`SweepIsWiredIntoCITests.test_EVERY_test_module_is_in_the_workflow_test_list`
in `flexfactor_invariant_sweep_tests.py`.

`flexfactor_autoclean_preverify_tests.py` exists on the PR branch and is
**not** in `.github/workflows/production-readiness.yml` after
`flexfactor_autoclean_tests.py`. Workflow file SHA at PR ref:
`77610ad0de134714ecd9eb9883d6d84140387c8e`.

The one-line wire (already committed locally as `06c7d10`):

```diff
                    flexfactor_autoclean_tests.py \
+                   flexfactor_autoclean_preverify_tests.py \
                    flexfactor_verified_sweep_tests.py \
```

`package-artifact` is skipped until both OS jobs pass. Do not treat packaging
as a second defect.

## Local landing commits (NOT on origin)

Checkout: `/home/ubuntu/flexfactor` on `cursor/pr110-ci-wire-a427`.
Do not `git add flexfactor` (symlink to `/home/ubuntu/src/flexfactor`).

| SHA | What |
|---|---|
| `06c7d10` | **THE MERGE BLOCKER** — wire `flexfactor_autoclean_preverify_tests.py` |
| `7aab5ec` | classify `Cross-file dependency` as no-fix; `_in_repo_rel` |
| `7452555` | `_should_retry_noop` for in-file / purpose-gap no-ops |
| `b15f048` | `tests/test_*.py` without packaging → `is_python=True`, unittest discover |
| `426193e` | `_apply_named_return_statement` before the model |
| `e1d22d7` | `_python_exe()` = `sys.executable`; py_compile + fixture tests use it |
| `f335a7b` | refuse whole-file fallback when apply_err contains `anchor not found` |
| `ac16a5b` | same refuse keyed on excerpt-gone, including silent no-op (`apply_err=""`) |
| `8d0bb28` | retry incomplete reviews on remaining cycles; drop stale purpose/final findings whose excerpt is already gone from HEAD |

Portable patch (also copied into this GrantFlow tree):
`docs/agent-sync/flexfactor-pr110-landing.patch`
(`git format-patch --stdout 634250c..HEAD`, 9 commits).
Same bytes on this host at `/tmp/flexfactor-pr110-landing.patch`.
One-shot apply from a writable token: `scripts/land-flexfactor-pr110.sh`.

Verified locally this session (`python3 -m unittest … -q`):

- `RelComponentsTests.test_named_return_swaps_only_the_defect_line`
- `RelComponentsTests.test_fix_files_applies_named_return_before_the_model`
- `RelComponentsTests.test_python_exe_is_this_interpreter_not_bare_python`
- `RelComponentsTests.test_missing_anchor_refuses_whole_file_when_excerpt_is_gone`
- `RelComponentsTests.test_stale_review_finding_is_gone_from_current_tree_not_the_patch`
- `RelComponentsTests.test_drop_stale_purpose_gaps_marks_criteria_met`
- `RelComponentsTests.test_incomplete_review_retries_before_last_cycle`
- `SweepIsWiredIntoCITests` (workflow list includes the preverify module)

## Write attempts this session (all refused)

`gh` identity is the GrantFlow integration (`cursor`).
`repos/buckeye7066/flexfactor` permissions: all false.
Tried and **403 / invalid token**:

- `git push` to `fix/autoclean-verifies-what-it-commits`
- Contents API PUT of the workflow file (GET of SHA succeeded)
- `POST /repos/.../forks`

This environment’s `repos` list is **only** `github.com/buckeye7066/GrantFlow`.
A FlexFactor-scoped cloud agent (or adding `buckeye7066/flexfactor` to the
environment with write) is the only way these commits reach origin.

Do **not** force-push `main`. Do **not** open a second overlapping PR if you
can push onto #110’s existing branch.

## Option 4 (so other apps can be run through FlexFactor)

Launcher item 4 = `prodready`. Ollama is up on this host:
`llama3.2:1b`, `llama3.2:latest`, `qwen2.5-coder:1.5b`, `qwen2.5-coder:3b`.

A fixture **without** an authored purpose contract is
`weakly-inferred` → `purpose_mutation_authorized=False` →
`cap = 0` at `flexfactor.py` ~16711. Purpose gaps are **reported, not
bridged**. Named-return never runs. That is why earlier option-4 runs
on `/tmp/ff-option4-*` stayed at `return a - b` even after the apply
loop was wired.

Required on the **target program** (GrantFlow, ForgePress, …), not a
FlexFactor code change:

- `.flexfactor-purpose.json`, or
- `docs/purpose-contract.md` (`## Purpose` + `## Acceptance`), or
- `PURPOSE.md`

`--trust-repo` is required on this host (no OS sandbox). `--no-dashboard`
is required (no tkinter on the root `flexfactor.py`). Full suite without
`--trust-repo` exits 126.

Fresh fixture this turn: `/tmp/ff-option4-proof` with
`docs/purpose-contract.md` authorizing `add(a, b)` = sum.
Log: `/tmp/ff-option4-proof.log`.

### Option 4 result (same VM, local `e1d22d7` tree — VERIFIED)

Without a purpose contract the first start printed
`gap-driven fixes NOT authorized` and never reached apply.

Restart with `docs/purpose-contract.md`:

- Purpose: **owner-authored, AUTHORIZED**
- Stack: `python=True test_cmd=yes` (the `b15f048` fixture detector)
- Phase 1: 2/4 criteria, 6 gaps entered the stream
- `[fixed] hello.py` — `add()` became `return a + b`
- Independent check immediately after that write:
  `python3 -m unittest discover -s tests -q` **OK**, `add(2,3)=5`

A later whole-file fallback (free `qwen2.5-coder:3b`) appended
`test_add` / `test_greet` into `hello.py`. `add()` stayed `a + b`,
tests still OK. Do not treat the free 3b author as a clean
unattended rewriter — the planted sum **was** landed, then the
file was dirtied. Named-return did not print `[named-return]` on
this run; the first `[fixed]` line is the apply that mattered.

Do not treat “purpose gaps closed 1/1” as proof `add()` is fixed —
read `hello.py`. This run: `return a + b` is present, `return a - b`
is gone.

### Option 4 on `8d0bb28` / fixture `/tmp/ff-option4-exit0` (in flight 2026-09-01T21:48Z)

Local FlexFactor tip `8d0bb28`. Host now has `coverage` 7.16.0 importable.
Command: `prodready --provider ollama --model qwen2.5-coder:3b --competitor-count 1`
(competitors ON; `--no-competitors` is an intentional product-invariant blocker).
Phase 0 already wrote `return a + b` and committed GREEN. Log:
`/tmp/ff-option4-exit0.log`. Do not treat mid-run as EXIT 0.

### Option 4 on `f335a7b` / fixture `/tmp/ff-option4-ready` (2026-09-01T21:27–21:35Z)

Author: `qwen2.5-coder:3b`. Purpose contract authorized. Makefile + CI +
`.gitignore` + README + LICENSE + `.env.example` seeded so the readiness
rubric could close.

- Phase 0 `[baseline-repair]` wrote `return a + b` from the failing
  `test_add` output; `make` + unittest GREEN; committed on fixture `master`.
- `[edit-keep]` refused the first missing-anchor whole-file attempt.
- A later silent no-op still printed `[edit-fallback] … edits were a no-op`
  (`ac16a5b` closes that door). Generation then failed (`Unterminated
  string`); `hello.py` stayed clean — no appended test functions.
- Independent after-run check: `add(2,3)=5`, suite OK, file is only
  `add`/`greet`.
- Readiness scorecard: **PRODUCTION READY 13/13, 0 blockers**
  (`/tmp/ff-option4-ready/ff-option4-ready_readiness.md`).
- Factory still **EXIT 1**: qwen 3b semantic review is INCOMPLETE
  (ungrounded findings → `RuntimeError` at `_postprocess_review_findings`),
  so the run reports ZERO WORK / not a verified-complete state. Purpose
  assessor stayed UNSTABLE at 1/4 even after `add()` was correct. Do not
  treat EXIT 1 as “add() is still broken.” Do not treat 13/13 as
  FlexFactor-the-product being mergeable — that is still PR #110.

## What the next FlexFactor-scoped agent must do

1. Check out `fix/autoclean-verifies-what-it-commits` at `634250c`.
2. Apply `docs/agent-sync/flexfactor-pr110-landing.patch` from GrantFlow
   PR #1442 **or** cherry-pick `06c7d10..ac16a5b` from
   `/home/ubuntu/flexfactor` if the same VM.
3. Minimum to unblock merge: land `06c7d10` alone, then wait for exact-head
   production-readiness green. The other seven commits make option 4 able
   to apply a finding-named return on Debian/`python3`-only hosts and
   refuse a vandalizing whole-file fallback — land them on the same PR
   so “production-ready” includes the apply path.
4. Re-run `SweepIsWiredIntoCITests` + `RelComponentsTests` + the new
   `_python_exe` test.
5. From a FlexFactor-writable checkout of GrantFlow, run
   `scripts/land-flexfactor-pr110.sh` (exits 3 if this token still lacks
   `permissions.push`). It applies the patch onto
   `fix/autoclean-verifies-what-it-commits` and pushes.
6. Confirm a **new** `production-readiness` run on the **new** head is
   green on both OS jobs, then merge. Rotation-extensions should stay green.

## Do not

- Treat #110 as mergeable at `634250c`.
- Re-diagnose rotation-extensions as red without a new failed run.
- Claim option 4 production-ready from a weakly-inferred fixture.
- Spend this GrantFlow token looping Contents PUT / fork / push.

## PromoPilot follow-up (remeasured 2026-09-01T21:48Z)

Live SHA still `b68d809`. `/healthz` live; scheduler+publishing enabled.
Portfolio **ARMED** / live / daily cap 2. `armed_at` 2026-09-01T12:52:39Z.
`killed_at` still 2026-08-06T15:42:36Z. Drafts **0**. Calendar days **0**.
Newest recent post still 2026-08-06T20:21:12Z Mastodon **failed**
(`login is currently disabled`). YFG approved rev 4 with bluesky allowed;
Ellie always-on approved rev 2 also allows bluesky. Generate still dies
at `canonical_cta_mismatch` before a draft row is written.
`buckeye7066/promopilot` still 404. Do not dest-approve Mastodon.
Do not publish. Do not leave URLs in YFG snippet/description.
