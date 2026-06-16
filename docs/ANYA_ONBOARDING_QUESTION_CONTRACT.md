# Anya Onboarding Question Contract

GrantFlow's first-time-user onboarding (entry point: `/login?entry=axiom-grantflow` → `/AnyaOnboarding`) feels like a friendly conversation, but internally it must satisfy a structured **intake contract**. This doc is the source of truth for that contract.

The contract has three layers:

1. **`ANYA_ONBOARDING_INTAKE_CONTRACT`** — the minimum data required for a useful GrantFlow profile
2. **`ANYA_ONBOARDING_FIELD_MAP`** — every question → the intake field, profile fields, readiness category, and matching/Robert-search impact
3. **`ANYA_ONBOARDING_QUESTION_TREE`** — the concrete walkable conversation tree any UI runs

All three live under [`backend/services/anya/`](../backend/services/anya/) and are consumed by Sam's onboarding auditor.

## Universal required fields

Onboarding cannot complete without these — they apply to every profile branch.

| Intake field          | Question id (default)         | Readiness category | Matching | Robert search |
|-----------------------|-------------------------------|--------------------|----------|---------------|
| `profile_type`        | `universal.profile_type`      | identity           | high     | high          |
| `profile_name`        | `universal.profile_name`      | identity           | low      | low           |
| `location_state`      | `universal.location_state`    | location           | high     | high          |
| `location_city`       | `universal.location_city`     | location           | high     | high          |
| `who_needs_help`      | `universal.who_needs_help`    | identity           | medium   | medium        |
| `what_they_need`      | `universal.what_they_need`    | funding_needs      | high     | high          |
| `amount_or_unknown`   | `universal.amount_or_unknown` | amount             | medium   | medium        |
| `urgency`             | `universal.urgency`           | timeline           | medium   | medium        |
| `preferred_help_types`| `universal.preferred_help_types` | funding_needs   | medium   | medium        |
| `short_description`   | `universal.short_description` | narrative          | high     | high          |
| `pace_preference`     | `universal.pace_preference`   | identity           | low      | low           |

### Universal recommended fields

`location_zip`, `deadline`, `documents_available`, `known_eligibility_facts`, `voluntary_demographics`, `notes`, `contact_preference`. Asked only when the user picks `keep_asking` for `pace_preference`.

## Branches

Anya identifies the profile type early and branches into one of:

1. `individual`
2. `family`
3. `student`
4. `church`
5. `ministry`
6. `nonprofit`
7. `school`
8. `volunteer_fire_department`
9. `small_business`
10. `other_organization`

Each branch defines `required_fields`, `recommended_fields`, and `sensitive_fields` (see [`anyaOnboardingIntakeContract.js`](../backend/services/anya/anyaOnboardingIntakeContract.js)). For example:

| Branch                     | Required (excerpt)                                             | Sensitive                                |
|----------------------------|----------------------------------------------------------------|------------------------------------------|
| individual                 | `primary_need`, `urgency`, `amount_or_unknown`                 | `household_income_range`, `disability_or_health_need`, `veteran_status` |
| student                    | `school_name_or_target`, `field_of_study`, `student_funding_need` | `gpa_or_test_scores`, `voluntary_demographics` |
| church                     | `church_name`, `denomination`, `church_need_category`, `tax_status_known` | `denomination` |
| volunteer_fire_department  | `department_name`, `vfd_need_category`, `service_area`         | (none) |
| small_business             | `business_name`, `industry`, `business_funding_need`           | `annual_revenue_range`, `minority_woman_veteran_ownership` |

The complete contract is the canonical reference — this table is illustrative.

## Field map

Every question has an entry of the shape:

```js
{
  question_id,              // e.g. "church.tax_status_known"
  branch,                   // null for universal, otherwise one of SUPPORTED_BRANCHES
  intake_field,             // canonical field id (stable across question wording changes)
  prompt,                   // default conversational text Anya uses
  required,                 // contract requires this question?
  sensitive,                // optional + must explain rationale
  readiness_category,       // one of identity/location/funding_needs/amount/eligibility/org_status/documents/timeline/narrative/contact
  maps_to_profile_fields,   // [{ table, column, transform? }]
  matching_impact,          // 'high' | 'medium' | 'low'
  robert_search_impact,     // 'high' | 'medium' | 'low'
}
```

The map is the **only thing UIs and Sam's auditor read**. When question wording changes, only `prompt` updates — `intake_field` stays stable.

## Question tree

`ANYA_ONBOARDING_QUESTION_TREE` is the walkable structure. The UI reads:

- `flow.universal_opening` — first questions, always asked
- `flow.branches[<branch>].required` — required for that branch
- `flow.branches[<branch>].recommended` — only asked when `pace_preference === 'keep_asking'`
- `flow.universal_keep_asking` — recommended universal questions

`walkOnboarding({ branch, pace })` yields the ordered list any UI walks.

## Conversation rules (enforced by Sam)

1. The flow starts with broad, low-friction questions.
2. `profile_type` is asked at position 1 (or 2, if a warm greeting precedes it).
3. After branch selection, only branch-relevant questions are asked.
4. Every non-identity question accepts `answer | skip | i_dont_know`.
5. Sensitive questions are always optional, must explain why we're asking, and must accept skip.
6. No question is repeated within a single walk.
7. `quick_start` mode trims recommended-only questions; it never drops required fields.
8. Onboarding completes only after every required intake field is answered, skipped, or marked I-don't-know.

## Privacy

- Anya logs structured events into `anya_onboarding_events`: `session_id`, `user_id`, `profile_id`, `branch`, `question_id`, `field_key`, `status`, `confidence`, plus minimal `details_json`.
- Raw user answers are **never** echoed back through the events table or audit summaries. Sensitive answers are persisted via the existing profile-fields path with profile-scope access control, never as transcript text.
- Sam's auditor surfaces only structural counts (questions asked, sessions completed, drop-off points) — never user text.

## Mission alignment

The contract intentionally separates **required** from **recommended** rather than gating with hard filters. Profile attributes increase score; missing fields default to neutral, never exclusionary. This mirrors GrantFlow's mission rules in [`backend/config/missionGoals.js`](../backend/config/missionGoals.js).
