# GrantFlow End-User Workspace and Automation Roadmap

## Product decision

GrantFlow will operate as two deliberately different workspaces:

1. **Owner/admin workspace**: the current full GrantFlow interface remains available to the canonical owner account (`buckeye7066@gmail.com`) and other DB-recognized administrators.
2. **End-user workspace**: ordinary users see only the funding journey they need to understand: Dashboard, Calendar, Pipeline, Item Requests, and Ask Anya.

The application's discovery engines, profile analysis, crawlers, match scoring, document processing, pricing logic, application generation, portal automation, reporting, and diagnostics remain available in the background. They stop competing for attention in the end-user navigation.

## Experience principles

- One visible guide: Anya.
- One funding source in active focus at a time.
- One next best action at a time.
- Progressive disclosure instead of feature menus.
- Background automation with visible status and safe interruption.
- The owner/admin workspace is a regression-protected control surface.
- Billing, entitlements, and crawler intensity use one canonical policy.
- Every submission and deadline is recorded in GrantFlow, even when the final action occurs outside GrantFlow.

## Phase 1: simplified end-user shell

This branch implements the first safe product slice:

- Owner/admin detection that explicitly preserves the canonical owner account.
- Full existing navigation for admins.
- Reduced end-user navigation:
  - Dashboard
  - Calendar
  - Pipeline
  - Item Requests
  - Ask Anya
- Removal of the end-user profile selector and advanced-tools switch.
- Removal of competing end-user tours, page coaches, match popups, Robert popups, and the floating Anya button. Users still have Anya on the Dashboard and in Help.
- Role-aware routes that leave the existing admin Calendar, Pipeline, and Help pages unchanged.
- A purpose-built end-user Calendar.
- A purpose-built Anya Help Center.
- A one-source-at-a-time Hamilton Pipeline.
- An end-user Dashboard summary showing pipeline count and potential value.

### Phase 1 acceptance criteria

- The owner account sees the existing full sidebar and existing Calendar, Pipeline, and Help pages.
- An ordinary user sees no Profile, Discovery, Matcher, Reports, Billing, Automation, Data Source, Diagnostics, or Admin navigation item.
- An ordinary user can reach Dashboard, Calendar, Pipeline, Item Requests, and Ask Anya in one click.
- Calendar date squares are fully colored, not merely marked with dots or badges.
- Green means a pipeline step was completed.
- Yellow means a pipeline step is needed by that date.
- Red means the final funding-source submission deadline.
- A date with multiple items uses equal-width color segments.
- Pipeline opens one funding source in a primary work area.
- A live Hamilton task prevents a second application from being started until the first is completed or cancelled.
- Hamilton's existing task drawer remains the place to watch progress, provide missing information, toggle auto-submit, stop work, and download generated packets.

## Phase 2: Anya as the end-user operating layer

Anya will become the only general-purpose assistant presented to end users. Robert, Hamilton, crawlers, matching engines, and document agents become named capabilities that Anya coordinates.

### Required end-user tools

Add the following read-only or confirmation-gated tools to Anya's chat whitelist:

| Tool | Purpose | Write safety |
|---|---|---|
| `profile.getCompletionStatus` | Identify profile gaps and the highest-value next question | Read only |
| `profile.updateSection` | Save a user-supplied answer into the correct profile section | Confirmation gated |
| `anya.nextBestAction` | Return one grounded next action | Read only |
| `pipeline.getSummary` | Counts, amounts, stage, blockers, and closest deadline | Read only |
| `application.getStatus` | Current submission state, completed steps, pending steps, and missing documents | Read only |
| `application.completeStep` | Mark a user-confirmed step completed | Confirmation gated |
| `fundingSource.getContact` | Return stored program officer, email, phone, mailing address, and source URL | Read only |
| `fundingSource.refreshContact` | Run a bounded contact lookup when stored details are missing | Confirmation gated and audited |
| `admin.getSupportContact` | Return the GrantFlow administrator contact | Read only |
| `hamilton.getActiveTask` | Explain what Hamilton is doing and what is blocking him | Read only |
| `hamilton.supplyMissingInfo` | Save a user answer to the active task and profile when appropriate | Confirmation gated |

### Conversation rules

- Anya should answer factual questions only after using the relevant profile-scoped tool.
- When a gap is found, Anya asks one concrete question, explains why it matters, and offers to save the answer.
- Sensitive profile facts remain optional and require a plain-language reason.
- Anya never directs ordinary users to hidden profile, crawler, analytics, or admin screens.
- Anya may contact the owner/admin through the configured support channel, but she must not expose internal admin data.
- When no funder contact is stored or verified, Anya says so instead of inventing one.

### Support contact

Canonical end-user administration contact:

- `dr.johnwhite@axiombiolabs.org`

This value should move to one server-side configuration constant and one public support endpoint so UI copy, email templates, and Anya cannot drift.

## Phase 3: initial interview, profile classification, and tier recommendation

The initial Anya interview should produce four separate decisions. They must not be collapsed into one ambiguous "tier" field.

1. **Profile type**: individual, family, student, church, ministry, nonprofit, school, volunteer fire department, small business, or other organization.
2. **Service preference**: discovery only, guided application help, or managed automation.
3. **Organization size/seat band**: individual, one login, two to five logins, or six-plus logins.
4. **Discount eligibility**: student, minister/clergy, hardship, pro bono, or none.

### Interview output contract

Add a versioned result object:

```json
{
  "profile_type": "nonprofit",
  "service_preference": "guided",
  "recommended_experience": "guided",
  "recommended_tier_id": "growth",
  "seat_band": "one_login",
  "discount_candidates": ["hardship"],
  "recommendation_reasons": [
    "Application help requested",
    "Six-month deadline",
    "Single-user organization"
  ],
  "confidence": 0.88,
  "missing_inputs": []
}
```

Anya recommends the tier and explains why. She does not silently purchase, upgrade, or enroll the user. The user confirms or chooses a lower level.

### Crawler and capability policy

Create a canonical `capabilityPolicyForAccount()` service that converts tier and profile needs into bounded background resources.

| Experience | Discovery | Profile enrichment | Contact research | Hamilton | Submission |
|---|---|---|---|---|---|
| Explore | Scheduled standard crawl | On demand | Stored contacts only | Draft assistance only | User submits |
| Guided | Standard plus targeted crawls | Automatic gap-driven enrichment | Bounded refresh | One active application with review | User review by default |
| Managed | Deep targeted crawls and monitoring | Automatic | Automatic verified refresh | One active application to completion | Auto-submit when authorized |

The policy should specify job types, daily quotas, concurrency, source depth, refresh frequency, and which tool families are enabled. The UI should never infer these limits itself.

## Phase 4: unified billing and entitlement model

GrantFlow currently contains a canonical tier catalog plus older illustrative pricing cards. The older cards must be removed so users receive one answer to "What plan am I on?"

### Canonical billing rules

- `shared/tierCatalog.js` remains the source of truth for plan IDs, prices, seats, support hours, and capability flags.
- Student, minister, hardship, and pro bono remain discounts or overrides, not separate product tiers.
- Profile type influences eligibility and recommendations, not the plan name by itself.
- Seat band and service level remain separate inputs.
- The pricing engine produces the recommendation and rationale.
- Entitlement middleware enforces the result server-side.
- Crawler budgets and Hamilton capability use the same entitlement result.
- Every displayed price comes from the billing catalog API.
- Remove the hardcoded illustrative pricing array from `src/pages/Pricing.jsx`.
- Add a consistency test that fails if any UI plan ID, price, discount, or capability label is not present in the canonical catalog.

### End-user pricing presentation

Show one recommendation and two alternatives:

- **Explore**: discover, save, and track.
- **Guided**: discovery, organization, document help, and application guidance.
- **Managed**: deeper automation and Hamilton completion.

Detailed internal tiers and seat bands remain available to admins and in an optional comparison drawer.

## Phase 5: Hamilton single-application orchestration

Hamilton should advance an accepted funding source automatically as far as authorization and available information permit.

### Trigger

When a user accepts a funding source:

1. Create or reuse the pipeline grant record.
2. Create or reuse the application record.
3. Generate the initial action plan, required documents, milestones, and final deadline.
4. Apply the account's Hamilton entitlement and standing authorization.
5. Queue the application if no other non-terminal Hamilton task exists for the profile.
6. Otherwise place it in `waiting_for_turn` and show its queue position without opening a second workstream.

### State machine

```text
accepted
  -> preflight
  -> gathering_information
  -> gathering_documents
  -> drafting
  -> portal_ready | packet_ready
  -> waiting_for_user | waiting_for_admin | ready_to_submit
  -> submitted
  -> follow_up
  -> awarded | rejected | withdrawn
```

Every transition must be idempotent, timestamped, profile scoped, and linked to the funding source and application.

### User control

The live Hamilton workspace must provide:

- Current action and progress timeline.
- Draft fields and narratives that can be edited.
- Stop/cancel control.
- Continue control after a blocker is resolved.
- Auto-submit toggle.
- Final-review toggle.
- Portal credentials/session status.
- Required document checklist.
- Downloadable DOCX/PDF packet when there is no usable portal.
- Submission instructions for email, mail, fax, or other channels.

### Writing standard

Retain the existing seasoned MBA grant-writer directives and add automated quality gates:

- No invented profile facts.
- No unsupported statistics.
- No placeholders in final output.
- Required funder questions all answered.
- Word and character limits respected.
- Budget totals reconcile.
- Objectives are measurable.
- Narrative aligns with the funder's stated criteria.
- Final packet includes submission channel, address/URL, deadline, and attachment list.

## Phase 6: portal review and submission modes

### Auto-submit mode

When the user has explicitly enabled auto-submit and no hard stop remains, Hamilton may submit. The submission receipt, confirmation number, timestamp, portal URL, and final payload hash must be recorded.

### Review mode

When auto-submit is off, provide a two-pane workspace:

- Left pane: portal session or portal field list.
- Right pane: Hamilton's recommended value for the currently selected field, source facts used, character count, and Copy button.
- User may edit before copying or saving.
- The field map and changes are persisted so the application can resume without losing work.

A browser portal cannot always be embedded because many funders block iframes. The fallback is a synchronized live-view window plus the Hamilton field assistant in GrantFlow.

### No-portal mode

Hamilton generates a complete DOCX and PDF packet, names every required attachment, and provides verified submission instructions. The user can download from the same task screen and mark the real-world submission channel complete.

## Phase 7: submission ledger, calendar, and money accuracy

Create one authoritative submission ledger connected to grants, applications, Hamilton tasks, milestones, and awards.

### Required fields

- profile ID
- grant ID
- opportunity ID
- application ID
- Hamilton task ID
- submission channel
- final deadline
- submitted timestamp
- confirmation number
- requested amount
- awarded amount
- status
- last verified timestamp
- receipt/document IDs

### Calendar synchronization

- Application-plan steps create milestones.
- Hamilton step completion marks the milestone completed.
- Requirement or deadline changes update, not duplicate, the milestone.
- Final funding-source deadline always generates the red calendar item.
- Completed steps remain on their scheduled date as green history.
- Pending steps are yellow.
- Multiple items on one day are rendered as equal-width segments.
- Submission moves the final deadline to completed history only when the submission ledger confirms it.

### Pipeline money rules

- Active potential value uses requested amount, then maximum, then minimum, then listed amount.
- Awarded records use the awarded amount.
- Rejected, withdrawn, archived, deleted, and expired records are excluded from active potential value.
- Duplicate opportunity records are collapsed by canonical opportunity ID or normalized title/funder fingerprint.
- Dashboard, Pipeline, reports, and billing must use the same calculation service.

## Priority order

1. Protect the owner/admin workspace with regression tests.
2. Ship the simplified navigation and role-aware pages.
3. Ship the colored pipeline Calendar.
4. Make Help an Anya conversation and add the missing read tools.
5. Enforce one active Hamilton application per profile.
6. Automatically create application plans and milestones when a source is accepted.
7. Add the two-pane review mode and no-portal packet fallback.
8. Unify billing and tier-based capability policy.
9. Extend initial interview classification and tier recommendation.
10. Consolidate notifications so Anya communicates background-agent results.
11. Remove or archive duplicate onboarding tours and obsolete pricing UI.
12. Add funnel, automation, and submission-quality analytics.

## Verification and rollout

### Automated tests

- Owner email and all admin flag shapes receive the full workspace.
- Ordinary users receive only the reduced navigation.
- Admin routes render the existing components.
- Calendar creates green, yellow, and red items correctly.
- Calendar segmentation produces one equal segment per same-day item.
- Profile and grant scoping prevent cross-user data exposure.
- Anya cannot invoke admin tools for ordinary users.
- Profile writes require confirmation and merge safely.
- A second Hamilton task cannot start while another is active.
- Stop prevents subsequent Hamilton steps.
- Auto-submit cannot activate without explicit authorization.
- Submission creates or updates the ledger and calendar idempotently.
- Dashboard and Pipeline potential totals match.
- Pricing UI matches the canonical tier catalog.

### Rollout controls

- Feature flag the simplified workspace separately from Hamilton auto-start.
- Owner/admin bypass is always on.
- Pilot with a small group of ordinary accounts.
- Record navigation usage, interview abandonment, first match, first accepted source, first Hamilton run, blocker rate, submission rate, and seven-day return.
- Roll back the end-user shell without altering data or admin routes.

### Success metrics

- Median time from sign-in to a meaningful next action.
- Percentage of users who accept a funding source during the first session.
- Percentage of accepted sources that reach `ready_to_submit` or `submitted`.
- Median number of user decisions per completed application.
- Profile-gap questions answered through Anya.
- Hamilton blocker rate and mean time to resolution.
- Submission deadline miss rate.
- Support contacts caused by navigation confusion.

## Key caveats

- Portal embedding is not universally possible because funder sites may block iframes or require 2FA, CAPTCHA, payment, or legally personal attestations.
- Auto-submit must remain explicit, auditable, and reversible before submission.
- Tier-based crawler intensity must be enforced server-side; hiding UI is not an entitlement boundary.
- Potential funding is an estimate, not expected revenue.
- Funder contact details must carry source and verification timestamps.
- Profile updates must remain profile scoped and confirmation gated.
