# Amy × Repo Rewards × FlexFactor Scout

Owner directive (2026-07-25): teach Amy to use **Repo Rewards** and **Scout a
Program** to improve the crawlers, their gap coverage, and their use of profile
information — and to find other repos with a more optimal approach to surfacing
real, relatable funding sources for the needs of the profile. Weekly cadence:
Sunday mornings at 02:00.

## The two tools

| Tool | What it is | How Amy uses it |
|---|---|---|
| **Repo Rewards** (`G:\One Drive\Desktop\Repo Rewards.lnk` → https://web-production-d7db7.up.railway.app) | The owner's natural-language code-repository search engine (GitHub/GitLab/Codeberg/SourceForge/Bitbucket/Gitea/Forgejo) with an always-on safety gate and relevance/safety/trust/quality scoring. Nothing un-reviewed is ever returned. | `backend/services/amy/repoRewardsScout.js` — a search lane inside Amy's nightly competitive research. Queries are **derived from Amy's own latest training report**: her most-tripped gap finding types (hyperlocal recall, amount recall, false positives, …) each map to a query hunting code that fixes that gap, and the worst-served archetype contributes a needs-of-the-profile query. |
| **FlexFactor Scout** (`G:\One Drive\Desktop\Scout a Program.lnk` → `C:\Users\example_user\flexfactor\flexfactor_scout_launch.ps1`) | A deep-inspection tool: profiles a program, searches Repo Rewards for repos that would improve it, judges per-candidate benefit (with evidence matrices, license/injection/execution-risk verdicts, fail-closed safety gates), and writes a markdown benefit report. Report-only by default; apply mode integrates improvements on a local `flexfactor/adopt-*` branch (never pushes). | The weekly unattended run (below) points Scout at `C:\Users\example_user\GrantFlow` in **report-only** mode. |

## How the pieces connect

```
Amy nightly training run (synthetic profiles → crawler-os → findings)
        │  findings[] = where crawlers failed which archetypes
        ▼
crawlerCompetitiveResearch (nightly sweep, self-throttled ≥3 days)
   ├─ web lane: curated engineering queries → web hits
   └─ Repo Rewards lane: gap-derived queries → safety-screened repo hits
        │  one merged candidate pool
        ▼
skeptical LLM comparison vs CURRENT_APPROACH ("only if genuinely MORE optimal")
        ▼
system_kv `amy_crawler_research` (advisory snapshot; NOTHING auto-changes)
        ▼
Anya's 09:00 morning owner email — findings labeled "(via Repo Rewards)"

Weekly, Sunday 02:00 (local machine, Task Scheduler "Amy Weekly Repo Scout"):
FlexFactor Scout → GrantFlow, report-only, prod Repo Rewards
        ▼
docs/amy-scout-reports/YYYY-MM-DD-repo-rewards-scout.md
```

Both lanes are **advisory only** — the doctrine of `crawlerCompetitiveResearch`
holds: research never changes code or the catalog; a human judges the findings.
Apply mode exists but stays an interactive act: double-click **Scout a
Program**, choose `apply`, and confirm — integrations that pass the build land
committed LOCALLY on a `flexfactor/adopt-*` branch, never pushed.

## Configuration

| Env (backend) | Default | Meaning |
|---|---|---|
| `AMY_REPO_REWARDS` | `true` in prod; **off under a test runner** (`VITEST`) unless explicitly `true` — the lane's default URL is always reachable, so unit tests must opt in | Master switch for the Repo Rewards research lane. |
| `REPO_REWARDS_URL` | prod Railway URL | Point at `http://localhost:3000` for a local Repo Rewards dev stack. |
| `AMY_CRAWLER_RESEARCH` | `true` | The whole competitive-research goal (web + repo lanes). |

Bounds (in `repoRewardsScout.js`): ≤4 queries/run, ≤6 results/query, 90s
timeout per search. The finding-type → query map is
`GAP_QUERY_OF_FINDING`; config-tuning finding types (scoring floor, field
mapping) are deliberately absent — those belong to Amy's existing editors, not
to external code adoption.

## The weekly run (Sunday 02:00)

- **Task Scheduler**: `Amy Weekly Repo Scout` → `powershell -File
  C:\Users\example_user\flexfactor\amy_weekly_scout.ps1` (weekly, SUN, 02:00).
- **What it does**: FlexFactor Scout against `C:\Users\example_user\GrantFlow`,
  report-only, provider `openai` (falls back to `anthropic` if the OpenAI key
  is missing), against **prod** Repo Rewards (`--no-auto-start`, so the local
  dev stack is never booted unattended).
- **Where results land**: report →
  `docs/amy-scout-reports/YYYY-MM-DD-repo-rewards-scout.md`; log →
  `C:\Users\example_user\flexfactor\logs\amy_weekly_scout_YYYY-MM-DD.log`.
- Run it by hand anytime: `schtasks /Run /TN "Amy Weekly Repo Scout"`, or
  double-click the **Scout a Program** shortcut and drop the GrantFlow folder
  on it for the interactive version.

## Reviewing what Amy found

1. **Morning email** (Anya's daily owner report) — the "competitor crawler
   research" section; Repo Rewards findings are tagged `(via Repo Rewards)`.
2. **Weekly scout reports** — `docs/amy-scout-reports/`; each candidate carries
   scout's benefit verdict, evidence matrix, and safety verdicts.
3. To adopt something: prefer the interactive Scout apply flow (verified build,
   local branch, per-candidate approval), or hand the suggestion to Anya/a dev
   as a normal change with tests.

## Tests

- `backend/tests/repoRewardsScout.test.js` — query derivation from report gaps,
  SearchOutcome mapping, offline via injected fetch, env gates.
- `backend/tests/crawlerCompetitiveResearch.test.js` — the merged pool: dedup
  across lanes, `via`/`is_repo` carried into candidates + persisted findings,
  outage non-fatal, `AMY_REPO_REWARDS=false` skip.
