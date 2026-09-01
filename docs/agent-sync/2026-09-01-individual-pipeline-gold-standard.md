# 2026-09-01 — Individual pipeline gold standard (four gates)

Audience: every agent touching matching, pipeline admission, or Robert's
audit. Individual pipelines passed security review but were inflated with
rows that could not answer yes to the owner's four criteria.

## Directive

A source reaches a pipeline only when it is **real**, **relatable**, **meets
a need the profile declared**, and **the profile qualifies**. That bar is
now the admission gold standard for individual-root profiles, not only
Robert's auto-add path.

## Shipped

- `qualifyForPipeline` in `backend/services/robert/robertPipelineAudit.js`
  is the ONE four-gate implementation. `saveToProfilePipeline` (Gate 1.9),
  Robert auto-add (`qualifyForProfile`), and the individual-root boot net
  all consume it.
- Empty schema section keys (`housing`, `education`, …) are no longer
  declared needs. Measured 2026-08-23: those keys made every person-type
  profile look the same. Type parent-chain still derives
  `college_student` → `student` → education.
- Individual-root admission and the boot sweep require a **positive** need
  overlap. Fail-open silence stays for org/business removal so an
  unreadable row is counted, not deleted.
- Title-stated inference only (scholarship / Pell / FAFSA / SNAP / LIHEAP /
  veteran / emergency assistance) fills empty opportunity vocabulary so
  unlabeled HOPE/Pell and VA emergency rows still match.
  `opportunity_kind: scholarship` does **not** mint a need.
  Bare `VA` and bare `emergency` do not mint a need.
- RELATABLE no longer treats `no_fundable_signal` as a directory. A named
  award with only title+URL is relatable; pointer/search/aggregator
  reasons still fail.

## Traps

- Do not count empty section keys as needs again. Use
  `includeSectionKeys: true` only for a census of the old loose reading
  (`pipeline-precision-census.mjs --section-keys`).
- Do not map `opportunity_kind` onto a need. Kind is a structural class.
- Do not refuse `RESOURCE` / `no_fundable_signal` at RELATABLE — that
  starves Pell/HOPE/NAEMT fixtures that carry `url` and no categories.
- `from-opportunity` tests that expected `DECISION_ENGINE` must accept
  earlier gold-standard gates (`GOLD_STANDARD:QUALIFIES` / `NEED_COVERAGE`)
  unless the fixture is given a positive need so it can reach the engine.
- Org/business pipelines still fail-open on need silence (Olivia /
  type-derived `business`). Individual-root is the inflation class.

## In-flight

None from this session. Branch:
`cursor/individual-pipeline-gold-standard-9e67`.
