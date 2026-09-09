# Crawler applicant ancestry repair

## Changed

The canonical matcher now recognizes a declared profile type's registry parents
when matching applicant evidence. The profile normalizer also maps previously
unhandled registered types through the same applicant-family registry used by
crawler routing. This repairs two losses: a school district failed to earn the
`school` applicant signal, and entities such as museums and county governments
were rejected as unrecognized entity types before scoring.

The opportunity normalizer recognizes narrowly stated, affirmative government
eligibility in eligibility fields. A government sponsor or a negative statement
does not supply that evidence. Opportunity restrictions and the four-truth gate
remain authoritative. Signal version `2026.09.09-1` makes old verdicts stale for
the existing bounded refresh; capture-time reality evidence must be preserved.

## Verified during investigation

- Production main was `68a4e99b5075de3f162f8bc51fab3af302cc71ac`.
- A fresh, in-memory replay of the September 9 Amy school-district scenario
  stored 126 registry opportunities and returned zero direct recommendations.
  Its declared applicant signal was only `school_district`. The registry already
  records the ancestry `public_school`, `school`, `public_agency`.
- A controlled replay of the same captured candidate restored applicant proof
  when those existing parents were included. This established the lost type
  relationship; it did not independently verify every criterion of that award.
- A separate bounded live web run searched two queries, offered 16 pages
  including four known-source seeds, fetched 15, extracted four candidates,
  stored three, and returned zero direct recommendations. Search found the
  official Escambia Grants for Excellence page. Two extraction requests logged
  provider timeouts. Search quality and extraction remain separate limitations.
- The original nightly receipt remains 1 clean / 50 evaluated. It is historical
  evidence and must not be rewritten as a successful post-fix cohort.

## Validation and follow-through

Regression tests exercise the real canonical matcher and crawler four-truth
facade for school districts, school food services, museums, disabled adults,
seniors, and government eligibility prose. They preserve unknown-applicant,
student-only, organization-only, and negative-statement exclusions. The positive
cases failed before the repair. Focused suites, release gates, and deployed
discovery measurements are required before reporting completion.

Owner priority: crawlers are GrantFlow's core. App smoke checks cannot substitute
for real sources that meet declared needs and confirmed applicant eligibility.
