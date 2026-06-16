# Sam — Anya Onboarding Auditor

Sam audits the conversation Anya runs with first-time users. He has five sub-auditors, an orchestrator, and admin-only API endpoints.

## What Sam audits

The orchestrator [`samOnboardingConversationAuditor.runAudit`](../backend/services/sam/samOnboardingConversationAuditor.js) runs all of these in sequence:

| Sub-auditor                              | What it checks                                                                       |
|------------------------------------------|--------------------------------------------------------------------------------------|
| `samOnboardingQuestionContract`          | Universal & branch-required coverage; duplicates; field-mapping gaps; sensitive-question rationale & skippability |
| `samOnboardingBranchTests`               | Synthetic walk of every branch — dead ends, profile-type-too-late, repeated questions, quick_start completeness |
| `samOnboardingTranscriptAuditor`         | Reads `anya_onboarding_events` (when present), produces redacted summaries — completion rate, drop-off, sensitive-skip rate |
| `samOnboardingReadinessAudit`            | For finished onboardings, reads `computeDetailedReadiness` and flags low overall / Robert-search readiness     |
| `samOnboardingConversationAuditor`       | Aggregates findings, derives recommendations, persists run + findings (when audit tables exist)                |

## Branch coverage

Sam walks every branch under both `pace_preference` modes:

```
universal_opening → branch.required → (pace=keep_asking ? branch.recommended : ∅)
                                    → (pace=keep_asking ? universal_keep_asking : ∅)
```

Each branch must produce a walk that includes every field the contract marks `required`. `verifyQuickStartContainsAllRequired` separately confirms `quick_start` only trims **recommended** questions, never required ones.

## Finding severities

| Severity   | Meaning                                                                          | Examples                                                              |
|------------|----------------------------------------------------------------------------------|-----------------------------------------------------------------------|
| `critical` | Onboarding cannot complete usefully                                              | Missing universal question (profile_type, location, etc.); empty branch |
| `high`     | Branch-required field missing; quick_start drops a required field; Robert can't search | `missing_branch_question`, `quick_start_missing_required`, `robert_search_readiness_too_low` |
| `medium`   | Quality / wording issue                                                          | Repeated question, profile_type asked too late, sensitive question with no rationale |
| `low`      | UX suggestion                                                                    | Irrelevant question for branch; high sensitive-skip rate              |
| `info`     | Status note                                                                      | Readiness service not installed yet                                   |

## Privacy rules

Sam **must not** expose raw onboarding transcripts. The transcript auditor reads only structural events (`question_id`, `field_key`, `status`, `confidence`, timestamps) and reports aggregated summaries:

- `completion_rate`
- `drop_off_points` (top 10 question_ids with most abandonments)
- `sensitive_skip_rate`
- `average_questions_seen`

Sensitive intake fields are flagged via a hard-coded set in [`samOnboardingTranscriptAuditor.js`](../backend/services/sam/samOnboardingTranscriptAuditor.js); skipping them is tracked but the answer text never leaves the profile data layer.

## Recommended fixes

For every finding, Sam emits a `recommended_fix` action, deduplicated into `recommendations[]`. Examples:

- `Add a question to the church sub-tree that elicits "tax_status_known".`
- `Move universal.profile_type to the start of universal_opening.`
- `Update the prompt to explain why the answer matters and to mark it optional.`
- `Ensure required questions are actually answered (not just skipped) before marking onboarding complete.`

Sam **never auto-rewrites** Anya's conversation logic. Safe automated changes are limited to:

- regenerating the coverage report
- updating audit-run metadata
- marking superseded findings
- writing new telemetry rows

Code-level fixes always go through a human-reviewed PR.

## API

All routes require admin (`isAdminUser` middleware). Mounted at `/api/sam/onboarding-audit`:

| Method | Path                          | Returns                                                       |
|--------|-------------------------------|---------------------------------------------------------------|
| GET    | `/status`                     | quick health summary for Mission Control                      |
| POST   | `/run`                        | runs a full audit; persists run + findings if tables exist    |
| GET    | `/latest`                     | most recent run + its open findings                           |
| GET    | `/findings?status=open`       | findings list, filterable by status                           |
| POST   | `/findings/:id/resolve`       | mark resolved                                                 |
| POST   | `/findings/:id/ignore`        | mark ignored                                                  |

The `/status` endpoint reports table installation flags so Mission Control can render a clear "not installed" state instead of a 500.

## How to test onboarding quality

```bash
# 1. Run the full unit suite
node --test tests/unit/sam-onboarding-conversation-auditor.test.mjs \
            tests/unit/anya-onboarding-question-tree.test.mjs \
            tests/unit/anya-onboarding-field-map.test.mjs \
            tests/unit/anya-onboarding-branch-coverage.test.mjs \
            tests/unit/anya-onboarding-readiness.test.mjs

# 2. Run the auditor against a live DB
curl -X POST -H 'Cookie: <admin session>' http://localhost:3001/api/sam/onboarding-audit/run

# 3. Inspect findings in Mission Control under "Anya Onboarding Quality"
```

## Database tables

Three idempotent tables are created by migration `078_sam_anya_onboarding_audit.sql` (sqlite) / `0074_sam_anya_onboarding_audit.sql` (postgres):

- `anya_onboarding_events` — Anya writes events here at runtime
- `anya_onboarding_audit_runs` — one row per `runAudit` invocation
- `anya_onboarding_audit_findings` — individual findings per run

Each is created with `IF NOT EXISTS` and indexed for the read patterns the orchestrator and Mission Control use.

## Graceful degradation

Every Sam sub-auditor handles the case where a table or upstream service is missing:

- transcript auditor returns `{ installed: false, sessions: [], … }` if `anya_onboarding_events` is absent
- readiness auditor returns an `info`-severity finding (`readiness_service_unavailable`) if `computeDetailedReadiness` isn't exported in the current branch
- orchestrator persists when tables exist; otherwise reports `persisted: false` and the in-memory summary is still complete and consumable by the API
