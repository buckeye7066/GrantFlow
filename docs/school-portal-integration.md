# School Portal Integration Guide

GrantFlow's school-portal bridge lets a registered college, university, or high school
push student records from its student-information system (Banner, Workday, PeopleSoft,
Slate, Anthology Apply, etc.) into GrantFlow profiles, then read back the **real
funding sources each student is eligible for** so the school can render them inside
its own portal UI.

This document is for school IT / financial-aid integrators. It covers:

- [How the bridge works](#how-the-bridge-works)
- [Getting an API key](#getting-an-api-key)
- [Endpoints](#endpoints)
- [The student record schema](#the-student-record-schema)
- [What GrantFlow does with each field](#what-grantflow-does-with-each-field)
- [Consent + revocation](#consent--revocation)
- [Sample integration](#sample-integration)

## How the bridge works

```
+---------------------+     POST /students/sync      +-------------------------+
|  School SIS / SSO   | ---------------------------> |  GrantFlow API          |
|  (Banner / Workday) | <---------------------------  |  /api/school-portal/*  |
+---------------------+    GET /students/:id/matches +-------------------------+
                                                       |
                                                       |  merges into a real
                                                       v  GrantFlow profile,
                                                  +---------+
                                                  | profile  |
                                                  | sections |  <-- crawlers,
                                                  | matcher  |      matcher,
                                                  +---------+      Discover Grants
```

For every student record you POST:

1. We canonicalise the fields (GPA, major, enrollment status, FAFSA / Pell flags,
   demographics) onto the GrantFlow profile schema.
2. If we already have a profile for that student (matched by school email), we
   **merge non-destructively** — anything the student typed themselves is preserved;
   we only fill empty cells and add additive tags.
3. If we don't have a profile yet, we create one tagged
   `created_by = school-portal:<your-slug>`. The student can later claim it by
   logging in with their school email at `/start`.
4. The bridge is recorded in `school_student_links` with a `consent_status`
   (`granted` by default; `revoked` if the student opts out).
5. When you call `GET /students/:id/matches`, we run the same canonical matcher
   we use on the GrantFlow website and return the scored, ranked opportunities
   with reason codes you can render directly.

## Getting an API key

API keys are issued by a GrantFlow admin. Once you've registered your school:

```http
POST /api/school-portal/admin/partners        # admin-only
{
  "slug": "memphis",
  "name": "University of Memphis",
  "ipeds_id": "220862",
  "contact_email": "fa@memphis.edu"
}
```

Then issue a key:

```http
POST /api/school-portal/admin/partners/:id/api-keys
{ "label": "production-banner-export", "expires_in_days": 365 }
```

The response contains `api_key.raw` **once** — store it as a secret in your SIS
config. We only keep the SHA-256 hash. You can rotate by issuing a new key and
revoking the old one (`POST /admin/partners/:id/api-keys/:keyId/revoke`).

All authenticated requests use:

```
Authorization: Bearer <api_key.raw>
```

## Endpoints

### `GET /api/school-portal/me`

Returns the partner's identity and link count. Useful as a smoke test
after rotating a key.

### `POST /api/school-portal/students/sync`

Single record:

```json
{
  "external_student_id": "U12345678",
  "school_email": "jane.doe@memphis.edu",
  "full_name": "Jane Doe",
  "student_level": "Undergraduate",
  "primary_major": "Nursing",
  "cumulative_gpa": 3.42,
  "enrollment_status": "full_time",
  "expected_graduation": "2027-05-15",
  "home_state": "TN",
  "home_city": "Memphis",
  "zip_code": "38103",
  "fafsa_efc": 0,
  "is_pell_eligible": true,
  "is_first_generation": true
}
```

Or bulk:

```json
{ "students": [ { ... }, { ... } ] }
```

Returns `{ ok, succeeded, failed, results: [{ profile_id, action: 'created'|'merged' }], failures }`.

### `GET /api/school-portal/students/:external_student_id/matches?limit=25`

Returns the scored funding opportunities the matcher computed for the merged
profile. Each match has:

```json
{
  "id": "opp_…",
  "title": "Federal Pell Grant",
  "funder_name": "US Department of Education",
  "url": "https://studentaid.gov/pell",
  "amount_max": 7395,
  "deadline": "2026-06-30",
  "score": 38.0,
  "reasons": ["Applicant type match", "Amount eligibility"]
}
```

If `total_found > 0` and `included == 0`, that's our zero-result-protected fallback
relaxing constraints — see GrantFlow Mission Goal 8.

### `GET /api/school-portal/students/:external_student_id`

Returns the merged GrantFlow view of the student so your portal can show "what
GrantFlow sees" for transparency. Useful for debugging and consent UX.

### `POST /api/school-portal/students/:external_student_id/revoke`

Marks the link `consent_status = 'revoked'`. The student's profile stays — only
future syncs and `/matches` calls are blocked. The student can re-enable from
their GrantFlow profile page.

## The student record schema

Field aliases are matched case-insensitively. You can send any synonym from the
right-hand list and we'll canonicalise it.

| Canonical field          | Accepted aliases                                                                       |
| ------------------------ | -------------------------------------------------------------------------------------- |
| `external_student_id`    | `student_id`, `id`                                                                     |
| `email`                  | `school_email`, `student_email`, `primary_email`                                       |
| `full_name`              | `name`, `student_name`, `legal_name`                                                   |
| `current_institution`    | `school_name`, `school`, `institution`, `institution_name`, `university`, `college`    |
| `highest_level`          | `degree_level`, `level`, `enrollment_level`, `class_level`, `student_level`            |
| `intended_major`         | `major`, `primary_major`, `field_of_study`, `program`, `program_of_study`              |
| `minor_field`            | `minor`, `secondary_major`                                                             |
| `gpa`                    | `cumulative_gpa`, `overall_gpa`                                                        |
| `expected_grad`          | `expected_graduation`, `graduation_date`, `anticipated_graduation`                     |
| `enrollment_status`      | `attendance_status`, `enrollment`                                                      |
| `credit_hours`           | `credits_enrolled`, `current_credit_hours`                                             |
| `credits_earned`         | `credit_hours_earned`, `completed_credits`                                             |
| `residency_status`       | `residency`, `in_state`, `tuition_residency`                                           |
| `fafsa_efc`              | `efc`, `sai`, `student_aid_index`                                                      |
| `pell_eligible`          | `pell_grant_eligible`, `is_pell_eligible`                                              |
| `first_generation`       | `first_gen`, `first_generation_student`, `is_first_generation`                         |
| `financial_need_index`   | `financial_need`, `unmet_need`                                                         |
| `act_score` / `sat_score`| `act_composite`, `sat_total`                                                           |
| `zip_code`               | `zip`, `postal_code`                                                                   |
| `state` / `city` / `county` | `home_state`, `home_city`, `home_county`                                            |

Demographic / situational flags are additive tags only — they boost match scoring,
they never gate eligibility:

```
is_pell_eligible, is_first_generation, is_veteran, has_disability,
is_international, is_transfer, is_part_time, is_full_time, is_online,
is_dependent, is_independent, is_parent, is_caregiver, is_homeless,
is_foster_alumni
```

You can also send `tags: [ ... ]` as an explicit list — we canonicalise need-style
strings via the GrantFlow need vocabulary.

## What GrantFlow does with each field

- `current_institution`, `highest_level`, `intended_major`, `gpa`, `expected_grad`,
  `enrollment_status`, `credit_hours`, `act_score`, `sat_score` →
  `profile.sections.education.*`
- `email`, `full_name`, `phone`, `zip_code`, `state`, `city`, `county`, `date_of_birth`
  → `profile.sections.basic_information.*`
- `state` + `county` → `profile.sections.location_focus.*` (used by geo-aware
  crawlers + matcher)
- Demographic flags → `profile.tags`
- All school-sync sections include `school_provided_data: true` and a
  `last_school_sync_at` timestamp inside `programs_services` so analytics can
  always tell where the data came from.
- `highest_level` drives the suggested `primary_type`:
  - matches `high school | hs | secondary | grade N | 9th–12th` → `high_school_student`
  - matches `undergrad | freshman | sophomore | junior | senior | associate | bachelor`
    → `college_student`
  - matches `graduate | master | phd | doctor | doctoral | postgrad` → `graduate_student`
  - We **never** overwrite a more-specific `primary_type` the user already chose.

## Consent + revocation

GrantFlow respects student agency at every layer:

- Each `school_student_links` row has `consent_status` of `granted` (default),
  `pending`, or `revoked`.
- A student sees the bridge on their profile page and can revoke from there.
- A school can revoke server-side via `POST /students/:id/revoke`.
- Once revoked, `/matches` returns 403 `CONSENT_REVOKED`. The profile data is
  preserved, but no new syncs land and no funding queries return data.

## Sample integration

A minimal nightly export from your SIS to GrantFlow:

```javascript
import fetch from 'node-fetch'

const API = 'https://app.axiombiolabs.org/grantflow/api/school-portal'
const KEY = process.env.GRANTFLOW_SCHOOL_API_KEY

async function syncRoster(students) {
  const res = await fetch(`${API}/students/sync`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${KEY}`,
    },
    body: JSON.stringify({ students }),
  })
  if (!res.ok) throw new Error(`sync failed: ${res.status}`)
  const body = await res.json()
  console.log(`synced ${body.succeeded}/${body.received}`)
  return body
}

async function fetchMatches(externalId) {
  const res = await fetch(`${API}/students/${externalId}/matches?limit=25`, {
    headers: { 'Authorization': `Bearer ${KEY}` },
  })
  if (!res.ok) throw new Error(`matches failed: ${res.status}`)
  return await res.json()
}
```

Render the matches in your portal however you like — title, amount, deadline, the
official source URL, and the reason codes are all in the response. Linking each
match back to the official source URL keeps you compliant with GrantFlow Mission
Goal 1 (real funding only) and Goal 7 (clear discovery UI).

## Support

Open an issue at https://github.com/buckeye7066/GrantFlow/issues with the
`integration:school-portal` label, or email the GrantFlow team. Include your
school slug, the request body, and the response status — never the raw API key.
