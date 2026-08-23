# 2026-08-23 — The first real e2e submit attempt: six blockers, six durable fixes

Audience: every agent working Hamilton/Anya/crawler code. Each lesson below is
ENFORCED IN CODE now — this doc exists so the next portal that fails gets
DIAGNOSED against these signatures instead of re-derived from scratch.

The live gauntlet was the U.S. Bank Student Scholarship form on a real student
profile. Runs 1→6 each died one layer deeper; every layer became a merged fix.

## 1. A validation stop on required SELECTs the profile can't answer
**Signature:** `blocker_kind: validation`, `submit_native_validation_failed`
with "Please select an item in the list", `unanswered_required_fields` lists
selects.
**Doctrine:** condition 2 — the orchestrator routes each to a profile home or
creates a GLOBAL custom field (`profile_custom_fields`, `resolveOrCreateFieldHome`)
and asks the owner. The owner's answer must be **option-exact** — the
answerer may only choose among the portal's own `<option>` texts.

## 2. The LLM field answerer silently neutered by a bulk profile column
**Signature:** zero `llm_field_answer` trace steps while
`generate_narratives` is authorized and unknown fields exist. Null answers
leave NO trace — check `buildProfileEvidence(profile).includes(<fact key>)`.
**Root cause class:** an 8.5MB base64 `avatar_data` row column was walked
FIRST; the 6KB evidence cap held only image bytes, so the model truthfully
said "the profile does not state this" to everything.
**Fix (merged #1325):** curated sections walk first; space-less blobs >400
chars never enter the evidence; 12KB fact budget. Regression test pins an
8.8MB blob.

## 3. A rule-MIS-CLAIMED field failing silently forever
**Signature:** one required field stays empty across runs with no trace;
`matchFieldKey` returns a rule for it ("Where did you hear about our
scholarship **program**?" → the `major` rule via the word "program"), and the
mapped value isn't among the select's options.
**Fix (merged #1326):** both rule-branch dead ends (missing mapped value;
portal-refused fill) fall through to the grounded answerer; the trace records
`misclaimed_rule`. Identity fields never fall through (vault-or-ask).

## 4. The receipt write failing on a SECOND, misplaced CHECK constraint
**Signature:** task → `submission_verification_required` with "could not
persist the run receipt", run row stuck `running`, while the canonical
constraint looks correct. **Always list ALL CHECK constraints on the table**:
`SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid =
'hamilton_autopilot_runs'::regclass AND contype='c'` — a stale
`yana_autopilot_runs_status_check` (old 8-status list) sat BESIDE the one
migration 0185 widened. The lockstep test reads the migration FILE and cannot
see a second live constraint.
**Fix:** migration 0186 drops it (idempotent; prod hand-repaired 06:1xZ).

## 5. A CAPTCHA token solved at page-open is dead by click time
**Signature:** captcha solved early (`captcha_result solved:true`), long fill
(~90s of LLM answers), then the POST silently rejected. reCAPTCHA tokens
expire ~120s and are single-use.
**Fix (engine):** `captcha_refresh_attempt` — when a captcha was present this
run, re-solve at the submit boundary, right before the click.

## 6. Receipt-silent portals: the form's own `retURL` is the truth oracle
**Signature:** post-click URL identical to the form URL, page re-rendered,
no acknowledgement, junk "reference" scraped from CSS ids.
**The insight:** a web-to-lead-style form DECLARES its success page —
`<input name="retURL" value=".../thank-you.html">`. The engine now captures it
(`declared_receipt_url` trace step) and adjudicates:
- Landing ON retURL ⇒ **confirmation evidence** (`declared_receipt_url`,
  durable with the retained owner document).
- Bouncing back to the ORIGIN form **re-rendered BLANK** with retURL never
  reached ⇒ `submit_rejected_bounce`, `provably_not_submitted: true` — the
  task returns to retryable `blocked`, NOT quarantine, because nothing was
  recorded funder-side. (Uncertainty still quarantines: the never-double-submit
  floor is unchanged.)

## Operating rules that made the diagnosis fast
- A null/failed path that leaves NO trace is invisible — when a layer "does
  nothing", reproduce it LOCALLY with the real prod bundle before touching code.
- The saved post-click page (`/data/uploads/hamilton-confirmations/*.html`)
  answers "did it submit?" — look for the form's action, retURL, whether the
  filled values survived, and any rendered (non-CSS) alert text.
- SQLite tests cannot see Postgres types or constraints (the recurring class:
  boolean columns, CHECK lists, REAL columns) — verify writes against prod
  Postgres when a "green" fix changes persisted values.
