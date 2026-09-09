# September 9 daily report: remaining AcademicWorks amount answers

The morning's eight-row reconciliation did not include two other titles named
in Amy's actual high-school amount finding: Argo Cyber Emerging Scholars (ACES)
and Argo Cyber Emerging Scholars Stipend (ACES). Both still pointed at the UWF
AcademicWorks index with `not_listed` amounts. The index contains many unrelated
awards, so a whole-page amount read cannot identify either award's value.

Read-only production verification found the exact linked source pages:

- https://uwf.academicworks.com/opportunities/9039 — the named scholarship's
  `Award` field says `Varies`.
- https://uwf.academicworks.com/opportunities/9430 — the named stipend's
  `Award` field displays `$0.00` and its description says to contact
  aces@uwf.edu for more information. Preserve these statements as
  `contact_required`; do not assert that a real stipend is worth zero or copy
  the separate scholarship's tuition benefit.

The listing adapter now owns these exact host/path/title combinations, requires
the matching page heading and one unambiguous `Award` definition-list field,
and reads only that field. A later positive source value can be parsed normally.
Missing headings, missing or conflicting fields, and unsupported zero displays
remain unresolved. Registry version 4 reopens previously attempted owned rows
through the existing boot reconciliation. The ordinary unattended sweep remains
limited to active grants; an explicit two-ID maintenance scope can reach these
orphan catalog rows without recreating deleted synthetic profiles.

Eight new regressions failed before the change; the initial three-suite run
passed 58 tests afterward. Full prepush and amount/invariant regressions are
required before merge, followed by an exact-deployment two-row read-back.

This source repair does not change eligibility, profile matching, search budgets,
or the historical 1/50 cohort result. The saved Amy report predates the repair;
a new measured cohort is required before claiming that its finding is resolved.
