# Yana — Outreach Strategy

This document describes how Yana (GrantFlow's Lead Discovery & Outreach
Agent — formerly codenamed "Larry") decides who to contact, when, with what
message, and through what channel. It is paired with
`YANA_LEAD_PIPELINE_AGENT.md` (the operator-facing doc) and exists to capture
*why* Yana's defaults are what they are.

> **Note on naming.** Internal identifiers (the `larry_*` table prefix, the
> `larryFitScorer`/`larryOutreachDrafter` module names, the `LARRY_*` env-var
> spellings, and audit-log `action=larry:*` rows) are kept for backward
> compatibility. The user-facing identity is "Yana"; the canonical env-var
> aliases are `YANA_LEADS_*`. Both spellings work.

## Audience

Yana's audience is "organizations that apply for grants" — not foundations,
not federal agencies. The seed source registry deliberately points at
directories of grant-seekers:

- IRS Tax Exempt Organization Search (BMF) — 501(c)(3)s, churches, schools
- USAspending.gov assistance awards — past federal grant recipients
- USFA National Fire Department Registry — volunteer fire departments / EMS
- NCES Common Core of Data — public/private K-12 schools
- State nonprofit / business registries — per-state expansion
- Community foundation grantee lists — proven local grant-seekers
- findhelp.org — local social services orgs
- Candid public org pages — corroboration of IRS BMF data

Government agencies, large for-profits, and publicly-traded companies are
explicitly excluded by `larryFitScorer.NON_GRANT_SEEKER_TYPES` — they don't
benefit from GrantFlow.

## Fit signals (max +100)

| Signal | Weight |
|---|---|
| Known grant-seeker applicant_type (`nonprofit`, `volunteer_fire_department`, etc.) | +25 |
| EIN present | +10 |
| Website URL present | +8 |
| Contact verified (live website + org email) | +12 |
| Contact partially verified | +6 |
| City + state present | +5 |
| Public programs listed | +10 |
| Recent grant history signal | +15 |
| Small-budget / volunteer-led signal | +5 |
| Rural / underserved signal | +5 |
| Mission aligns with declared need categories | +5 |

Missing fields never *subtract*. Per the project's standing rules, missing data
defaults to neutral. Score is confidence, not a hard gate.

## Urgency signals (max +100)

| Signal | Weight |
|---|---|
| Active capital campaign | +25 |
| Recent regional disaster | +20 |
| Public funding deadline within 60 days | +15 |
| Recent staff/leadership transition | +10 |
| Recent grant denial | +10 |
| Recently launched program | +10 |
| Recent news mentions (3 each, capped at 10) | up to +10 |

## Composite

```
composite = round(0.7 * fit + 0.3 * urgency)
```

The 70/30 split is intentional: a hot signal on a poorly-fit org is still a
poorly-fit org. We'd rather miss a fast-moving misfit than chase one.

## Qualification thresholds

Defaults (overridable via env):

```
MIN_FIT       = 60
MIN_COMPOSITE = 65
REQUIRE_VERIFIED_CONTACT = true
```

A lead must clear *all three* to enter the `qualified` queue. An admin can
override by manually approving an unqualified lead via the lead review modal.

## Outreach channel selection

Channel preference, in order:

1. `email` — when there is a primary contact email and the verification status
   is `verified` or `partial`.
2. `phone` — when only a phone is on file.
3. `contact_form` — when there is a website but no contact path on file.
4. `postal` — when only a mailing address is on file.

Yana currently only implements `email` send. The other channels are stored as
recommendations on the packet for human handoff.

## Email draft

Template: `yana_intro_v1` (legacy: `larry_intro_v1`). Every draft includes:

- The recipient's organization name (so it's never anonymous/templatic).
- One concrete reason GrantFlow believes they'd benefit (the top fit reason).
- An optional one-line urgency hook (the top urgency reason).
- A plain-language description of what GrantFlow does.
- A single explicit ask: "a 15-minute walkthrough."
- An on-ramp for self-service: a sign-up URL.
- A built-in unsubscribe-equivalent: "reply STOP and we'll add you to the
  suppression list."

Drafts are capped at 1800 characters and minimum 240. The drafter's quality
gate (`inspectDraftQuality`) flags drafts that are too short, too long, or
contain unfilled `{{placeholders}}`.

## Suppression list

Hard global block. Identifier types:

- `email` — exact recipient
- `domain` — entire email domain
- `ein` — IRS EIN
- `organization` — exact org name (case-insensitive)
- `phone` — digit-only phone

When an admin marks a prospect DNC, Yana adds *all* available identifiers from
that prospect to the suppression list so a future discovery run can't recreate
them under a different prospect row.

## Cooldown

Every successful send sets `cooldown_until = now + 14 days` on the relationship
row. Sends during cooldown are blocked. A reply (`recordRepliedRelationship`)
clears the cooldown immediately, since humans are now in the loop.

## Daily cap

`countSendsInWindow(db, {sinceIso})` is consulted before every send. When the
last 24h of sent attempts ≥ `YANA_LEADS_MAX_OUTREACH_SENDS_PER_DAY` (legacy
`LARRY_MAX_OUTREACH_SENDS_PER_DAY`, default 25), the gate refuses with
`daily_send_limit_reached`. The blocked send is recorded on the attempt row so
the admin sees exactly why nothing went out.

## Domain rate limits

`larry_domain_rate_limits` tracks request_count + window_start per domain.
`YANA_LEADS_RATE_LIMIT_PER_DOMAIN_PER_HOUR` (legacy
`LARRY_RATE_LIMIT_PER_DOMAIN_PER_HOUR`, default 30) caps adapter calls per
domain per hour. The window auto-resets after an hour without a request.

## Per-attempt admin approval

Default: ON (`YANA_LEADS_REQUIRE_APPROVAL_TO_SEND=true`, also accepted as
`LARRY_REQUIRE_APPROVAL_TO_SEND`). When on, the send gate returns
`send_not_approved` for any attempt without `approved_at` /
`approved_by_user_id`. The admin console requires an explicit click on
"Approve" before the "Send" button is enabled, and "Dry-run send" is always
available for spot-checking the gate without delivering to a real mailbox.

## What Yana never does

- Send without per-attempt approval (when the default is left in place).
- Bypass `email.js` / Resend (the same email pipeline the rest of the app uses).
- Send to disposable-email domains (`mailinator.com`, etc.).
- Send to placeholder domains (`example.com`, `localhost`).
- Add an organization to GrantFlow's user list.
- Touch `funding_opportunities`, `grants`, profile pipelines, or any of
  Robert's tables.
