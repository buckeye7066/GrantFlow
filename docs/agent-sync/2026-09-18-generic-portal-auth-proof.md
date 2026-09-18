# Generic portal access verification

The generic connector previously returned fields/awards without an `access`
classification. The production audit therefore could not distinguish a real
signed-in read from an HTTP 200 public page. Its empty-result note also claimed
successful sign-in without observing account controls.

The generic reader now requires a captured session plus visible logout and
account-navigation controls on the requested host. Password/sign-in walls,
blocked pages, foreign landings and failed observations do not prove access.
Only the observed account page is extracted; a generic reader has no reviewed
private-page map and cannot transfer authentication evidence to arbitrary links.
A second observation rejects results after a session expires during extraction.
The shared sync orchestrator refuses to persist explicitly unverified reads or
record them as completed. Blocking alone never expires a saved session.

Verification: ten generic-connector regressions and two orchestration regressions
failed before their repairs. All 58 related portal tests then passed. This is
not a claim that the user's current portal session is authenticated; that still
requires the explicitly scoped live audit after release. No acceptance threshold,
login credential, payment, or external submission is changed by these repairs.

Review follow-through: the requested host and its own subdomains, plus an exact
server-stored same-registrable-domain login host, can establish access. Unrelated
registrable domains and arbitrary sibling tenants remain refused. The backend
returns an actionable detail and the portal card uses the shared access-message
contract for both immediate errors and historical run summaries. Subdomain,
tenant-isolation, orchestration-detail and React message regressions pass.
