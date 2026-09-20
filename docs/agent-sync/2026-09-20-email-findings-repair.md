# Email finding evidence repair implementation plan

Goal: make Sam/Anya reports preserve finding-specific diagnostic advice and source references without concealing failures.
Architecture: keep existing finding and repair-plan contracts; carry references through INTERNAL checks and render the finding's recommendation.
Scope: reporting only. Provider availability, real award amounts, cohort acceptance and application readiness remain separately verified outcomes.
Base: ac30991cfcde77e1e3cfe2e4be909758951a165a.
Workspace: independent clone; existing Home GrantFlow checkout and its edit lock remain untouched.

## Constraints
- Do not access personal mailboxes or portal sign-in sessions.
- No production data edits, email sends, paid inference, or relaxed acceptance thresholds.
- Do not claim a named source file is defective merely because it is an investigation reference.
- No branch protection bypass, force push, or merge before required tests pass.

## Tasks
- [ ] Add failing tests for finding-specific repair summaries and INTERNAL finding references.
- [ ] Preserve recommendation text in samRepairPlanner.js without changing executable strategy/risk.
- [ ] Carry explicitly provided affected_files/affected_routes in samDiagnostics.js.
- [ ] Register investigation references for the four reported samRegistry.js checks.
- [ ] Test that attempted-but-unanswered amount rows do not imply a proven JS shell or mandatory API adapter.
- [ ] Replace that unsupported diagnosis while preserving the failing result and count.
- [ ] Run focused regressions and the repository test command; record actual failures.
- [ ] Review diff, publish PR, verify checks, merge through the guarded path, verify deployment.

## Verification status
Not yet repaired or verified. No production readiness claim.
