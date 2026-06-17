# Profile Readiness Score

The **Profile Readiness Score** tells the user (and Robert) how complete a
profile is and what to fill in next. It is GrantFlow's internal coaching
signal — it does **not** restrict matching, it improves it.

## Why this exists

Two callers depend on this:

1. **Anya** uses the per-category `recommended_questions` to pick the next
   thing to ask during onboarding or profile cleanup conversations.
2. **Robert** uses `readiness_score` to decide whether a profile has enough
   information to attempt high-quality, profile-specific recommendations
   (vs. broader Funding Library suggestions).

Profile fields **increase** the score, they never disqualify the profile
from matching. This honors the mission rule: *"profile fields increase
score, not eliminate results."*

## API

### Existing simple endpoint (unchanged, still used by gates)

```
GET /api/profiles/:id/readiness
```

Returns:

```json
{
  "profile_id": "abc",
  "ready": true,
  "score": 100,
  "missing": [],
  "guidance": null,
  "signals": { "applicant_type": "nonprofit", "location": { "state": "OH", "zip": "43215" }, "intent": { ... } }
}
```

`ready` is true when the profile has the three minimums needed to run a
useful match: applicant type, location, and at least one intent signal.

### New detailed endpoint

```
GET /api/profiles/:id/readiness/detailed
```

Returns:

```json
{
  "profile_id": "abc",
  "readiness_score": 87,
  "status": "excellent",
  "categories": [
    { "key": "identity", "label": "Identity / applicant type", "weight": 12, "earned": 12, "present": true,
      "missing_items": [], "recommended_questions": [] },
    { "key": "location", "label": "Location", "weight": 12, "earned": 12, "present": true, ... },
    /* 8 more */
  ],
  "missing_items": ["Add a city for sharper geographic matching."],
  "recommended_questions": ["When do you need this funding? Is there a specific deadline you are working toward?"],
  "impact_on_matching": "Profile is detailed enough for high-quality, targeted matches.",
  "updated_at": "2026-06-15T01:00:00.000Z"
}
```

`status` mapping:

| score | status      |
| ----- | ----------- |
| 0–34  | `poor`      |
| 35–64 | `needs_work`|
| 65–84 | `good`      |
| 85–100| `excellent` |

## Categories (10)

| key            | weight | what it measures                                      |
| -------------- | -----: | ----------------------------------------------------- |
| identity       |     12 | applicant type / profile category                     |
| location       |     12 | state, ZIP, city                                      |
| funding_needs  |     12 | focus areas, keywords, primary goal                   |
| amount         |      8 | dollar amount sought                                  |
| eligibility    |     10 | income, status, school type, household, etc.         |
| org_status     |     10 | organization type, tax/legal status (if applicable)   |
| documents      |      8 | uploaded supporting docs                              |
| timeline       |      8 | deadline / urgency window                             |
| narrative      |     12 | mission / project description (≥80 chars for full credit) |
| contact        |      8 | email, phone, website                                 |

Total weight = 100.

## Special cases

- **Individual / family profiles** are not penalized for missing tax
  status. They get partial credit by default.
- **Documents table missing** at boot returns `present: false` for the
  documents category but does not error.
- **Profile not found** returns `score: 0`, `status: 'poor'`,
  `missing_items: ['profile_not_found']`.

## UI

`src/components/readiness/ProfileReadinessScore.jsx` is the entry point.
It renders the score gauge and (when `compact={false}`) embeds the
`ProfileReadinessChecklist` for per-category guidance.

```jsx
import ProfileReadinessScore from '@/components/readiness/ProfileReadinessScore'

<ProfileReadinessScore profileId={activeProfileId} />
```

## Tests

`tests/unit/profile-readiness-detailed.test.mjs` covers:
- empty profiles → `poor`
- progressive scoring as fields are added
- per-category presence / missing items
- individuals not penalized for missing tax status
- organizations penalized for missing tax status
- a fully-filled profile → `excellent`
- status thresholds
- graceful degradation when documents table is absent
