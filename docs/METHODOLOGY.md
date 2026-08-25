# How GrantFlow Decides What Counts

*Intended for publication at axiombiolabs.org/grantflow/methodology.*

Every claim on this page corresponds to an enforced rule in GrantFlow's
codebase. Where a limit exists, it is stated. Where something is a report
rather than a verified fact, it is labeled as one.

---

## 1. What counts as a funding opportunity

**A directory is not funding.** Sites that list or refer you to other funders —
scholarship aggregators, resource pages, school portals, referral hubs — are
never certified as direct funding matches. They can appear in your results,
clearly marked, because they are sometimes useful starting points. They can
never be presented as money you can apply for.

> Enforced in `resourceDecisionGuard.js`. A directory or locator may reach
> REVIEW, but the ACCEPT certification is structurally unavailable to it.

**A past award is not an open opportunity.** Evidence that a funder gave money
to someone last year is intelligence about that funder, not an opportunity you
can apply to today. The two are stored and displayed as different things.

**A public page about a person is not that person's award.** Detecting a name
on a funder's website is not evidence that an award was made to your profile.

---

## 2. What a match score means

Your match score is not a marketing number. It is the output of one canonical
matcher, recorded with the exact evidence that produced it.

- **One authority.** Exactly one function decides ACCEPT / REVIEW / REJECT.
  Ranking heuristics elsewhere in the system are explicitly non-authoritative
  and cannot accept or reject anything.
- **Versioned provenance.** Every stored decision carries the matcher version,
  score scale, and evaluation timestamp. A result that cannot prove which
  matcher produced it is rejected at the persistence boundary rather than
  displayed.
- **Displayed equals stored.** The score you see is the score we persisted,
  re-checked against current policy. When policy changes lower a score, the
  change is written back so the two converge permanently. We do not show one
  number and keep another.
- **Evidence, not vibes.** Explanations cite how many of your substantive
  profile data points matched. Where that evidence is unavailable for an older
  record, the explanation says so instead of inventing a rationale.

> Enforced in `canonicalMatchAuthority.js`, `matchDecisionEngine.js`, and
> `persistedMatchTruth.js`.

---

## 3. What "submitted" means

This is the claim most easily faked in this industry, so it is the one we hold
most strictly. GrantFlow recognizes three distinct states and never blurs them:

| State | Meaning |
|---|---|
| **Externally submitted — portal confirmation on file** | The application was transmitted to the funder *and* a durable, retrievable confirmation artifact exists. |
| **Marked submitted (internal record — not confirmed sent to the funder)** | Our records say submitted, but no external confirmation was captured. Shown to you in exactly those words. |
| **Not submitted** | No submission. |

**A generated application packet is not proof of submission.** A drafted
proposal PDF is the thing we would send — never evidence that we sent it. This
rule exists because we found a real case in our own production data where a
task was marked submitted while the only attached document was a draft packet.
We fixed it and wrote the rule so it cannot recur.

Proof means one of: a submission run carrying a retrievable portal
confirmation; a portal-issued confirmation reference captured at submission; or
a portal receipt you uploaded yourself, bound to that specific application.

> Enforced in `submissionProofPredicate.js`, with an automated sweep
> (`submissionProofEnforcementSweep.test.mjs`) that fails the build if any
> user-facing surface reports a submitted status without consulting it.

---

## 4. What an outcome means

Awards and denials are recorded only against a durable funder response.

- Outcome records are **append-only**. A mistaken outcome is revoked with a
  stated reason and an actor; it is never deleted, and the original assertion
  stays auditable.
- Each record carries a **cryptographic hash** of the response document, so the
  evidence cannot be swapped after the fact.
- The older "mark this awarded" path was **removed**. It now refuses with
  `OUTCOME_EVIDENCE_REQUIRED` and directs you to attach the funder's response.

This means our reported "funds secured" figures cannot be inflated by a click.

> Enforced in migration `171_solicitation_requirements_lifecycle.sql` and
> `applicationLifecycleReadModel.js`. The database itself refuses a deletion,
> and refuses any update that is not a revocation carrying both a non-empty
> reason and the user who made it.

---

## 5. Duplicate applications

Many funders disqualify applicants who submit twice to the same program. When
GrantFlow can tell that you have already applied — either because it submitted
for you and holds the confirmation, or because you told us you applied
elsewhere — it stops before creating a second application and explains why,
with the prior record and a way to proceed if it is genuinely a new cycle.

Reports you give us are labeled as **your report**, never as a verified
submission. That distinction is stored, not just displayed: a record you assert
can never carry a confirmation reference, and cannot be silently upgraded into
one — the database rejects the attempt.

If you tell us you applied and later realize you were mistaken, the record is
**retracted with a reason**, not deleted.

**Limits, stated plainly.** This check matches on program identity rather than
on a specific listing, so it holds across cycles for programs identified by
title and sponsor. It is weaker where a funder issues a new opportunity number
each cycle, and it cannot know about an outside application you have not told
us about.

> Enforced in `priorCycleApplicationGuard.js` and migration
> `184_prior_cycle_application_claims.sql`.

---

## 6. How we measure ourselves

We hold ourselves to one bar: **GrantFlow must beat what you would find with a
free web search.**

This is measured, not asserted. On a schedule, for each benchmark profile, the
system runs a bounded web-search session — the budget a determined person would
actually spend — and compares those results against what GrantFlow surfaced.
The parity score is the share of real funding pages the web found that GrantFlow
already had.

- A session with no eligible web results is recorded as **unscored**, never as
  100%, and an unscored profile cannot inflate the fleet-wide number.
- Every opportunity the open web found and GrantFlow missed enters a gap queue
  as a labeled candidate.
- Candidates from that queue are **never auto-inserted** into the catalog. They
  pass the same verification gates as anything else.
- Parity regressions fail a health check. The number is only allowed to improve.

> Enforced in `webParityBenchmark.js`.

---

## 7. Known limits

Publishing a methodology means publishing what it does not cover.

- **Coverage is not complete.** No system sees every funding opportunity. Our
  parity benchmark measures the gap rather than hiding it.
- **Catalog data ages.** Funder deadlines and eligibility change; a listing can
  be stale between crawls. Always confirm details on the funder's own page
  before applying.
- **Eligibility screening is a filter, not a ruling.** Only the funder decides
  who is eligible. A high match score is not a promise of eligibility.
- **Automation cannot complete every portal.** Some require identity
  verification, phone confirmation, or steps only you can take. When automation
  cannot finish, GrantFlow produces a handoff with the real link, the specific
  missing items, and instructions — it does not leave the task silently parked.
- **Outcome data depends on you.** We can only record an outcome when the
  funder's response is provided to us.
- **Duplicate detection is not exhaustive.** See the limits stated in section 5.

---

## 8. What we will never do

- Charge a percentage of your award. Pricing is a flat fee for work performed.
- Present a directory or referral page as direct funding.
- Present a draft as a submission.
- Present an unverified report as a verified fact.
- Report an award without the funder's response on file.

If you find us doing any of these, that is a bug, and we want to hear about it.

---

## Maintenance note — read before republishing

This page is only worth publishing while every claim on it is true. A claim
here that drifts from the code is the same class of defect the page is about.

Each section names the module that enforces it. **Before republishing, re-verify
each one against the tree**, and treat any of these as a blocker:

- The three states in section 3 must match `SUBMISSION_PROOF_STATE` and
  `SUBMISSION_PROOF_LABELS` exactly, wording included — section 3 claims users
  are shown those exact words.
- Section 4's revocation semantics must match migration 171's triggers.
- Section 6 must match `webParityBenchmark.js` — in particular that unscored
  sessions are excluded from fleet parity, and that gap-queue candidates are
  never auto-inserted.
- Section 5 must match `priorCycleApplicationGuard.js`, including its stated
  limits. Do not soften those limits.

**Verification log**

| Date | Verified against | Result |
|---|---|---|
| 2026-08-25 | `main` @ `c4136987` | All sections checked against the modules they cite. Section 3's state labels were corrected to quote `SUBMISSION_PROOF_LABELS` verbatim; section 4 gained the trigger detail; section 5 gained its explicit limits. All cited modules and migration 171 confirmed present. |
