# Requested funding-use implementation plan

Goal: Preserve explicit requests through matching and show which requested expenses the source actually supports.
Architecture: Extend the existing declared-need boundary, not a separate matching engine. Reuse the same result in the canonical scoring adapter, pipeline admission, and existing result card. No schema or scoring-threshold changes.
Constraints: Source-only evidence; missing information means review, not invented eligibility; genuine partial matches remain possible. Existing hard eligibility and four-truth capture gates remain authoritative. No real applications, payments, credential changes, or unrelated profile edits.

- [x] Reproduce loss of Axiom-shaped building/equipment/supplies/salary requests on main and observe failing regressions.
- [ ] Preserve sanitized concrete requests; use structured type defaults only when no explicit requests exist.
- [ ] Add bounded source-owned funding-use evidence with supported, excluded, conditional and unknown states. Cover partial support, contradictions, unrelated mentions and rental versus purchase.
- [ ] Use the shared result in canonical decisions and pipeline admission; propagate evidence to the existing result card.
- [ ] Run focused and project verification, review, push a scoped PR, and verify deployment only through the existing release gates.

Evidence scope: Axiom-shaped regressions are synthetic tests, not proof of an authenticated Axiom crawl or availability of any named grant. Another session owns the benchmark and stacked crawler repairs; preserve those branches.