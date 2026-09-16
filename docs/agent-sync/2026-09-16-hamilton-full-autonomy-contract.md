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
  choke point; this correction changes documentation, not that gate.
- A contract test prevents the old owner-only submission prohibition from being
  reintroduced and asserts the docs remain connected to the tier and consent
  choke points.
