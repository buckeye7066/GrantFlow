# FlexFactor option-4 / PromoPilot — 2026-09-02T00:23Z

## FlexFactor — PR #110 MERGED; apply-path still not on main

- Repo: `buckeye7066/flexfactor` (public). Write from this token: **403**.
- PR: https://github.com/buckeye7066/flexfactor/pull/110 — **MERGED**. Merge SHA `edfc4744` (CI wire only). Do **not** reopen.
- `origin/main` tip: **`3b6760d451fb5a2392a8d34a9c9f0603d18746b9`** ("Autoclean verifies exact candidates and prevents behavior weakening").
- production-readiness at merge SHA: **SUCCESS** on ubuntu, windows, `package-artifact` (run 33565932180).
- rotation-extensions: **SUCCESS**.
- `.github/workflows/production-readiness.yml` on main includes `flexfactor_autoclean_preverify_tests.py`.

`origin/main` still does **not** contain the option-4 apply-path. A FlexFactor-writable agent must:

1. Branch **`fix/option4-apply-path` from `origin/main` (`3b6760d`)**.
2. Cherry-pick **`7aab5ec^..ad29c9d`** (skip `06c7d10` — already on main).
3. Open a **new** PR. Wait for exact-head production-readiness green on **both OS**. Merge.
4. One-shot: GrantFlow `scripts/land-flexfactor-pr110.sh` (exits 3 if no write).

Do **not** force-push `main`. Do **not** loop Contents PUT / fork / push from a GrantFlow token.

## Local apply-path tip: `ad29c9d`

`/home/ubuntu/flexfactor` on `cursor/pr110-ci-wire-a427`. Do **not** `git add flexfactor` (symlink).

Commits after `634250c`:

| SHA | What |
|---|---|
| `e8685f7` | Unmapped competitor ACCEPT → explicit purpose-fit reject |
| `596b4a8` | Drop invented SyntaxError + baseline-checkout claims |
| `478205b` | Drop already-satisfied findings from the ledger (`change X to X`) |
| `462fb37` | Same drop **before** `_fix_files` + refuse whole-file when all targets already satisfied |
| `3964f2b` | Drop “greet returns without the name” when `{name}` is in the tree |
| **`ad29c9d`** | Flip remaining undeliverable ACCEPTs to explicit purpose-fit reject; drop “``add`` is not invoked” when `add(` exists |

Portable patch: `docs/agent-sync/flexfactor-pr110-landing.patch` (`7aab5ec^..ad29c9d`).

## Option 4 — `/tmp/ff-option4-name` EXIT 1 (honest)

Engine `3964f2b`. Command: `python3 … > logfile 2>&1; echo EXIT:$? | tee -a logfile`.

- Cycle 1: both files **clean**, purpose **4/4**, suite GREEN, readiness **13/13**.
- Tree still `return a + b` + both tests.
- Failed: `selected-capabilities-delivered` (Django ACCEPT `code_fixable=false` stayed selected) + leftover independent-review title `Missing function invocation` (`The \`add\` function is not invoked` while tests call `add(2, 3)`).
- Manifest: `/tmp/ff-option4-name/ff-option4-name_run_manifest_20260902T002143019140.json`.
- **Fixed in `ad29c9d`.** Next plant: `/tmp/ff-option4-cap`. Do not restart finished fixtures.

Prior closed classes: pandas ACCEPT, stale `a - b` in reproduction, SyntaxError+checkout, change X to X (ledger + whole-file), greet-without-name.

Success = `hello.py` is `a + b`, `test_greet` present, **EXIT:0**, `converged: true`, `independent-final-review` **passed**, `selected-capabilities-delivered` **passed**.

`--no-competitors` is an **intentional blocker**. Do not n/a those gates.

## PromoPilot — live SHA changed; still no drafts

Production: `https://promopilot-production-6370.up.railway.app`
Live SHA: **`d433fb6bf42ec8ff8b3fe7ce8691c29012632d85`** (was `b68d809`). Frontend `/app.js` still 99861 bytes.

- `/healthz` live; scheduler+publishing enabled. `/readyz` ready.
- Portfolio **ARMED**. `killed_at` **2026-08-06T15:42:36Z** is why the month went silent.
- Drafts **0**. Calendar days **0**. Newest post still **2026-08-06T20:21:12Z** Mastodon **failed** (`login is currently disabled`).
- Verified dests: Axiom Bluesky (`dest-axiom-biolabs-bluesky-default`, 2026-09-01T19:19:15Z), Ellie Bluesky (`dest-ellie-williams-bluesky-elliewrites`, 2026-09-01T19:29:37Z).
- Campaigns: `campaign-your-first-grant-always-on` approved rev 4 (includes bluesky); `campaign-ellie-williams-always-on` approved rev 2 (includes bluesky). Other Axiom campaigns still `[youtube, facebook_page, threads, x]`.
- Generate-draft is only `POST /api/post-now`. Do **not** publish. Last generate probes (old SHA) died before a draft row: `canonical_cta_mismatch` / `needs_campaign_approval`.
- `buckeye7066/promopilot` **404**. This token cannot write it.

Do not dest-approve Axiom Mastodon. Do not publish. Do not leave URLs in YFG snippet/description.

## Do not

- Treat #110 as still open or still red.
- Claim option 4 production-ready from 13/13 readiness or EXIT 1.
- Spend this GrantFlow token looping FlexFactor write.
- Recreate CreateGoal. Mark the goal complete.
- Combine `pkill` of `flexfactor.py` in the same shell as `git commit`.
