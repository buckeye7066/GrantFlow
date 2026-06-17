# Sam — Agent Auditor

Sam is GrantFlow's audit-and-test agent. He doesn't ship features; he watches the rest of the agent ecosystem, looks for regressions, and surfaces actionable findings to administrators.

## Scope

Sam audits:

| Area                              | Sub-auditor / docs                                                |
|-----------------------------------|-------------------------------------------------------------------|
| Anya onboarding conversation flow | [`SAM_ONBOARDING_AUDITOR.md`](./SAM_ONBOARDING_AUDITOR.md)         |
| (planned) Robert search behavior  | future PR                                                          |
| (planned) Yana lead discovery     | future PR                                                          |
| (planned) John outreach drafting  | future PR                                                          |

This document describes the cross-cutting principles. For the onboarding-specific audit see the linked sub-doc.

## Anya onboarding quality checks (summary)

Sam verifies that Anya's first-time-user onboarding (entry: `/login?entry=axiom-grantflow` → `/AnyaOnboarding`):

1. starts with broad, low-friction questions
2. identifies profile type early
3. branches correctly based on profile type
4. collects every universal-required intake field
5. collects every branch-required intake field
6. asks no irrelevant or duplicated questions
7. asks sensitive questions only with a clear rationale and an optional skip
8. allows "I don't know" and skip on every non-identity question
9. avoids dead-ends and infinite loops
10. produces a profile whose readiness score lets Robert search effectively
11. logs structured events without exposing raw user text

The audit is implemented in [`backend/services/sam/`](../backend/services/sam/) with five focused modules and a single orchestrator (`runAudit`). The canonical question contract Sam audits against is [`ANYA_ONBOARDING_QUESTION_CONTRACT.md`](./ANYA_ONBOARDING_QUESTION_CONTRACT.md).

## Operating principles

- **Read-only by default.** Sam never auto-rewrites conversation logic, prompts, profile data, or other agents. Safe automatic actions are limited to: regenerating coverage reports, updating audit metadata, marking stale findings superseded, and inserting non-destructive telemetry rows.
- **Graceful degradation.** Every sub-auditor handles the case where its upstream table or service isn't installed yet — returning a structured "not installed" payload rather than throwing.
- **Privacy-preserving.** Sam reports structural counts (sessions started/finished, drop-off question ids, sensitive-skip rate) — never raw user text.
- **Admin-only surface.** All Sam endpoints require admin authentication. Sam intentionally exposes no per-user routes.
- **Findings are reversible.** Each finding has an `open | resolved | ignored | superseded` status; resolving or ignoring a finding never deletes the underlying telemetry.

## Severity & category vocabulary

Sam normalises every finding to:

```
severity:    critical | high | medium | low | info
category:    one of a small, fixed enum (e.g. missing_universal_question,
             missing_branch_question, duplicate_question, field_mapping_gap,
             sensitive_no_rationale, missing_skip_path, low_onboarding_completion_rate,
             frequent_drop_off, readiness_too_low_after_onboarding,
             robert_search_readiness_too_low, irrelevant_question, etc.)
branch:      one of the supported profile branches, or null
question_id: the canonical question id, or null
title, description, recommended_fix, evidence: human-readable + structured payload
```

Mission Control groups findings by `severity` first, then `category`, so an admin can fix the highest-impact issues first.

## Where Sam is wired today

- Service modules live under `backend/services/sam/`.
- Admin routes are mounted at `/api/sam/onboarding-audit` (see [`backend/routes/samOnboardingAudit.js`](../backend/routes/samOnboardingAudit.js)).
- Database tables: `anya_onboarding_events`, `anya_onboarding_audit_runs`, `anya_onboarding_audit_findings` (migrations 078 / 0074).
- Tests: `tests/unit/sam-onboarding-conversation-auditor.test.mjs`, `tests/unit/anya-onboarding-*.test.mjs`.

When new audit areas (Robert / Yana / John) are added, follow the same shape: a per-area sub-auditor + a small orchestrator + admin-only routes + idempotent migrations + targeted unit tests.
