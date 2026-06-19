<!--
GrantFlow PR template. Keep this short. The goal is not bureaucracy —
the goal is to make sure every PR can be evaluated against the
mission-goals rule:

  "Real funding only. Match to actual needs. Use the full profile.
   Avoid zero results. Geographic matching expands outward."

If you are using auto-push-fixes (the agent committing direct to main),
this template is the description that goes in the commit message body
or the agent's summary. The headers below are a checklist, not a form.
-->

## What was broken / what does this change

<!-- One or two sentences. If a fix, name the symptom the user saw.
     If a feature, name the user-visible behavior added. -->

## Why this fix works

<!-- Root cause, not surface description. If a regression, link the
     prior commit/PR that introduced it. -->

## Mission-goal check

- [ ] No new hard boolean filters (no AND-style eligibility gates)
- [ ] Missing/null profile fields default to **neutral**, not exclusionary
- [ ] If `total_found > 0` is possible, `included === 0` is logged + relaxed (not silently dropped)
- [ ] Directory-style funding resources are NOT filtered out by default
- [ ] Geographic match still expands outward: city → county → state → national

(Tick what applies. If a row is N/A — e.g. pure UI change — say so.)

## How verified

<!-- Concrete: which test(s), which command, which sample profile.
     "I clicked around" is not verification. "npm run -s unit" with the
     ensure-schema-invariants suite passing is verification. -->

- [ ] `npm run -s unit` (or the targeted suite for the change)
- [ ] `npm run check:prepush` (lint + typecheck + vite build) for any
      change touching shared bundle code
- [ ] Manually walked one real profile end-to-end and confirmed
      multiple funding sources are returned (for matching/crawler/UI changes)

## Reversibility

<!-- Mission rule: "Any new logic must be: traceable, logged
     (lightweight), reversible." If this PR adds new behavior gated by
     an env flag, name the flag. If it changes a default, name the
     opt-out. If it migrates data, name the rollback path. -->

## Out of scope (don't review for these here)

<!-- Optional. Anything you intentionally did not touch in this PR. -->
