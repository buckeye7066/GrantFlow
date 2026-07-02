# Amy — Synthetic Crawler-Training & Improvement Agent

**Goal: improve the crawlers.** Amy generates **highly varied, synthetic**
GrantFlow profiles, runs a **real crawler event at the 75% slider** against each,
**measures** crawler quality, and **closes the loop**: it auto-tunes the
(reversible) match score floor when the cohort proves a better one, hands the
implicated files to **Anya** (root cause) → **Sam** (verified safe fixes), and
stages deeper changes (source coverage, scoring weights) into an **approval
queue** shown in the admin panel. Every profile is tagged so **Sam** can safely
delete it — and is **never deleted until it has been crawled at least once**.

## The improvement loop

1. **Crawl at 75%** — each synthetic profile gets ≥1 real `runProfileDiscoveryLive`
   event at `floor = DEFAULT_MIN_SCORE` (the slider). Scored candidates are retained.
2. **Measure** (`crawlerMetrics.js`) — cohort coverage / zero-result /
   false-positive rates, and a **floor sweep**: because the floor is applied
   after scoring, Amy re-scores the collected candidates at every candidate
   floor to find the threshold that maximizes `quality = coverage − 0.6·false_positives`.
3. **Tune** (`crawlerTuner.js` + `matchThresholdEditor.js`) — if a better floor
   is proven on a big-enough cohort (≥12) with real gain, Amy applies the change
   through the live scoring store — bounded (±10, **hard-clamped to ≥75**: the
   documented display floor can be tightened but never loosened), backed up, and
   verified (auto-revert on mismatch). This is a genuine, persistent, reversible
   crawler improvement.
4. **Learn per archetype** (`archetypeLearning.js` + `crawler-os/archetypes.js`)
   — the cohort's systematic misses (institution recall, hyperlocal recall,
   low-results) are recorded per **archetype** (student / veteran / senior /
   caregiver / first responder / nonprofit / …) in `system_kv
   amy_archetype_learning`. The live crawl (`attachLearnedGaps` in
   `crawlerOsService.js`) classifies every REAL profile's thesis with the same
   classifier and merges the archetype's learned gap classes into
   `thesis.learned_gaps`, so `buildWebQueries` **targets the proven weakness on
   the very next crawl** — a lesson learned on a synthetic veteran steers every
   real veteran, including brand-new profiles with no crawl history. Safety:
   learning is whitelisted to additive query-steering classes only; it can never
   touch an eligibility gate, score floor, or policy.
5. **Measure per archetype** — every run appends per-archetype
   qualified/ineligible-accept counts to `system_kv amy_archetype_metrics`
   (rolling 30-run history) so the evolution is verifiable run-over-run; it is
   surfaced on the admin crawl-coverage dashboard (`amy_learning` section) and
   in the Amy panel.
6. **Hand off** (`amyPipeline.js`) — Anya runs its autonomous code crawl on the
   files Amy flagged (root cause + optional safe code fixes); Sam runs its
   verified safe-fix pass. Deeper levers go to the **approval queue**; items an
   auto-applied lever already addressed are annotated `auto_applied` (audit
   trail: what changed, which run, which finding).
7. **Report** — a combined report is persisted (`amyReportStore.js`, `system_kv`)
   and shown in the admin panel under **Agent Amy**, plus JSON artifacts.
8. **Cleanup** — only profiles crawled ≥1 are deleted (hard invariant).

## Admin panel

A dedicated **Agent Amy** tab (`src/components/admin/AdminAmyConsole.jsx`, wired
in `src/pages/Admin.jsx`) shows: coverage/zero/false-positive metrics, the
floor-tuning result (before→after, applied + backup), the improvement approval
queue, what Anya saw, and the Anya/Sam chain outcome. It has a **Run now** button
(`POST /api/amy/run`) with an opt-in "apply tuning" checkbox.

Backend API (`backend/routes/amy.js`, admin-only, mounted at `/api/amy`):
`GET /status`, `GET /report/latest`, `GET /reports`, `GET /approvals`, `POST /run`.

---

Amy generates **highly varied, synthetic** GrantFlow profiles, runs them through
the existing **Crawler OS** discovery pipeline, measures where the crawlers
succeed or fall short, and emits a structured **handoff report for Anya** (who
evolves crawler code). Every profile Amy creates is tagged so **Sam** can safely
delete it during cleanup sweeps.

> **No real personal data.** All Amy identities are synthetic: names are
> `Amy Synthetic — <Label> #<n>`, emails use the reserved `.invalid` TLD, and
> phones use the reserved `555-01xx` range. Locations are real US cities used
> only for geographic realism.

## Where it lives

| Concern | Path |
|---------|------|
| Constants + Anya code-target map | `backend/services/amy/amyConstants.js` |
| Metadata block + seeded RNG | `backend/services/amy/amyMetadata.js` |
| Synthetic profile catalog (32 categories) | `backend/services/amy/syntheticProfileCatalog.js` |
| Profile store (create + safe cleanup) | `backend/services/amy/amyProfileStore.js` |
| Evaluation + Anya handoff builder | `backend/services/amy/amyReport.js` |
| Archetype classifier (shared producer/consumer key) | `backend/crawler-os/archetypes.js` |
| Archetype learning + per-run metrics | `backend/services/amy/archetypeLearning.js` |
| Live-crawl consumption of learned gaps | `attachLearnedGaps` in `backend/services/crawlerOsService.js` |
| Orchestrator | `backend/services/amy/amyAgent.js` |
| Daily scheduler | `backend/services/amy/amyScheduler.js` |
| CLI: training run | `scripts/amy-train.mjs` (`npm run amy:train`) |
| CLI: Sam cleanup | `scripts/amy-cleanup.mjs` (`npm run amy:cleanup`) |
| Tests | `backend/tests/amyAgent.test.js`, `backend/tests/amyArchetypeLearning.test.js` |

## How it runs

Amy reuses the production discovery seam `runProfileDiscoveryLive` from
`backend/services/crawlerOsService.js` (the same path the discovery routes and
Robert call). It does **not** add a parallel crawler.

1. **Generate** varied scenarios across all categories (business, nonprofit,
   school district, college/university, students, homeschool family, individual
   assistance, cancer/chronic-illness/disabled, veteran, military family, single
   parent, grandparent caregiver, foster youth, DV survivor, disaster survivor,
   faith-based, tribal, rural health clinic, research lab, CDC, housing
   authority, agricultural cooperative, workforce/apprenticeship).
2. **Insert** each as a fully-seeded profile (all schema sections), tagged
   synthetic + Sam-cleanable + traceable.
3. **Run discovery** for each profile. **Dry-run by default** — the pipeline
   runs for real but does **not** flush opportunities/matches to the live
   catalog, so only the synthetic profile rows persist. Use `--persist` to write
   matches.
4. **Evaluate** each result into structured findings (zero-result, weak match,
   no-qualified-match, scoring-floor suppression, source-fetch failure, URL
   issues, profile-field mapping miss, geo issues, discovery skip/exception).
5. **Emit artifacts** under `audit-reports/` (gitignored):
   - `amy-to-anya-handoff-<runId>.json` — Anya-consumable report.
   - `amy-run-<runId>.json` — full per-scenario run log.
6. **Cleanup** — by default Amy deletes the synthetic profiles it created. With
   `--keep-profiles` they remain tagged + expiring for Sam.

### Examples

```bash
npm run amy:train                                   # all categories, dry-run discovery, auto-cleanup
npm run amy:train -- --count=100                     # exactly 100 profiles spread across categories
npm run amy:train -- --per-category=2
npm run amy:train -- --categories=veteran,nonprofit,cancer_patient
npm run amy:train -- --keep-profiles                # leave for Sam's sweep
npm run amy:train -- --list-categories
```

## Daily run (100 profiles/day)

A background scheduler runs Amy once per day. It is **off by default** (like
every sibling agent) and is enabled with `AMY_ENABLED=true`. The daily volume
defaults to **100 profiles**, distributed evenly across all categories.

| Env | Default | Purpose |
|-----|---------|---------|
| `AMY_ENABLED` | `false` | Master switch for the daily scheduler |
| `AMY_RUN_ON_SCHEDULE` | `true` | Run once per day (when enabled) |
| `AMY_RUN_ON_STARTUP` | `false` | Also run ~1 min after boot |
| `AMY_DAILY_PROFILE_TARGET` | `100` | Profiles generated per day |
| `AMY_PERSIST` | `true` | Store discovered opportunities in `funding_opportunities` so agent Robert can parse them (synthetic profiles + scoped matches are still cleaned up). Set `false` for measurement-only dry runs |
| `AMY_KEEP_PROFILES` | `false` | Leave profiles for Sam instead of auto-clean |
| `AMY_FLOOR` | `75` | Match-score floor for the crawler event (the slider) |
| `AMY_IMPROVE` | `true` | Run the Anya→Sam chain + tuning measurement |
| `AMY_APPLY_TUNING` | `true` | Auto-apply the proven, reversible floor change |
| `AMY_APPLY_LEARNING` | `true` | Record per-archetype query-steering lessons the live crawl consumes (additive-only) |
| `AMY_ANYA_APPLY` | `false` | Let Anya write code fixes (else analysis only) |
| `AMY_SAM_APPLY` | `true` | Let Sam apply + save its safe fixes |
| `AMY_INTERVAL_MS` | `86400000` | Override the 24h cadence (testing/ops) |
| `AMY_AUTO_CLEANUP` | `false` | Let Sam's nightly sweep delete expired Amy profiles |

To turn it on at 100/day:

```bash
AMY_ENABLED=true            # daily scheduler on; AMY_DAILY_PROFILE_TARGET defaults to 100
```

The scheduler runs at most one job at a time (in-memory flag + DB scheduler
lock), never blocks startup, and writes the same artifacts as the CLI.

## Anya handoff shape

The handoff mirrors what `admin.anya.runAutonomous` returns (so it sits naturally
in `audit-reports/`): a flat `findings[]` of
`{ file, line, type, severity, message, excerpt, fixable, search_kind:"amy_synthetic_training", evidence }`
plus an `amy_summary` (per-status, per-category, per-finding-type aggregates and
`recommended_focus` — the repo files with the most findings). Each finding's
`file`/`line` points at the real crawler/scoring/source code Anya should evolve
(see `CODE_TARGETS` in `amyConstants.js`).

## Data safety & Sam cleanup

Every Amy profile carries:

- `profiles.created_by = "agent:amy"` (robust cleanup key)
- `profiles.tags` includes `synthetic`, `amy`, `amy_crawler_training`,
  `allow_sam_cleanup`, `amy_run:<id>`, `amy_scenario:<id>`
- a `amy_metadata` section with the full block:

```json
{
  "synthetic": true,
  "origin_agent": "Amy",
  "pipeline": "amy_crawler_training",
  "amy_run_id": "...",
  "scenario_id": "...",
  "created_for": "crawler_training",
  "allow_sam_cleanup": true,
  "created_at": "<iso>",
  "expires_at": "<iso, +24–72h>",
  "ttl_hours": 48
}
```

`cleanupAmyProfiles()` (used by `npm run amy:cleanup` and the nightly sweep)
**only** deletes rows where `created_by === "agent:amy"` **and** the metadata
marks `synthetic` + `allow_sam_cleanup`, and **never** a designated/system
profile. It can scope to expired-only (default in the sweep), a single run, or
all Amy profiles.

```bash
npm run amy:cleanup -- --dry-run            # safe preview (default)
npm run amy:cleanup -- --apply              # delete expired synthetic profiles
npm run amy:cleanup -- --apply --all        # delete all Amy synthetic profiles
npm run amy:cleanup -- --apply --run=<id>   # delete one run's profiles
```

The nightly Sam sweep (`backend/services/maintenance/nightlySweep.js`) will call
the expired-only cleanup when `AMY_AUTO_CLEANUP=true` (off by default).
