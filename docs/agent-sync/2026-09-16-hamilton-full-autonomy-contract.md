# 2026-09-16 — Hamilton Complete Autonomy contract correction

## Owner directive

The controlled-beta language that categorically required the owner to perform
every real-domain final submission was stale and contradicted the shipped
authorization model.

For a profile on an eligible tier, enabling Complete Autonomy is permission for
Hamilton to complete a real-domain application end to end, including use of the
profile's vault-backed login references, configured CAPTCHA/verification helpers,
matching standing attestations, and the final Submit action.

This is not permission to bypass the canonical gate. Immediately before the
irreversible action, Hamilton must still verify the active profile authorization,
`submit_applications`, `allow_auto_submit`, absence of any human-review veto,
durable task intent, and lack of revocation. Unsupported or unresolved gates stop
honestly. A run becomes `submitted` only after new durable portal confirmation is
captured.

## Code alignment

- Tier eligibility is enforced on the Hamilton automation router by
  `requireHamiltonPipelineAutomation`.
- `hamiltonFullAutomationMode.js` defines the complete capability grant and the
  profile-wide consent predicate.
- The orchestrator's canonical submission decision remains the irreversible
  choke point. The review correction also made the live task flag decisive at
  that gate, so a task-specific disable cannot be widened by profile authority.
- A contract test prevents the old owner-only submission prohibition from being
  reintroduced and asserts the docs remain connected to the tier and consent
  choke points.

## Review correction

- Removed the remaining fixture-only and mandatory-owner-submit language from
  the Hamilton guide and aligned the binding automation charter with supported,
  compliant verification helpers and standing attestations.
- Restored the promised per-task veto at the canonical submission decision:
  Complete Autonomy supplies authority and its enable flow arms workable tasks,
  but `application_tasks.allow_auto_submit = false` remains decisive even while
  the broader profile grant is active.
- Strengthened the contract guard to assert the actual tier-gated router mount
  and the orchestrator's live-task recheck wired into `runAutopilot`, rather
  than checking for disconnected tokens.

## Production deployment and preflight evidence

- PR #1714 passed every reported check, including the binding `test` and
  `test-suite` jobs, and was merged through `scripts/codex-merge-pr.sh`.
- Exact merge SHA `9a53b72b09ecf361954bef63fac95d7456a2177d` deployed successfully to
  Railway and Vercel.
- Read-only production smoke run `35061115392` passed against that exact SHA,
  including the public `/readyz` mission gate.
- The protected, profile-scoped production audit was rerun as `35061180884`.
  It passed all 17 database findings, authenticated as the non-admin audit
  account, completed all four scoped application reads with HTTP 200, validated
  the running-process boot identity, scanned the report for secrets, and
  uploaded the sanitized artifact.
- The audit observed one open Hamilton task, no unresolved missing-information
  rows, ten redacted portal sessions, and five pipeline applications in the
  approved profile scope. These counts establish that a candidate path exists;
  they do not prove that the open task itself has Complete Autonomy, a usable
  live session, a supported portal, or durable submission confirmation.

## Current P0 disposition

The Complete Autonomy contract and its task-level revoke boundary are deployed.
The next acceptance operation is the real task preflight and, only if every
canonical decision is green, Hamilton's real portal run. Phase 3 remains open
until the product retains newly captured, owner-retrievable confirmation; task
presence, a submit click, or an internal `submitted` label does not close it.
