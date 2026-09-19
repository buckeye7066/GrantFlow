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

The live follow-up on September18 reached public landing pages. The generic
reader now follows at most one visible, same-origin GET login/account link using
the already-captured session, then requires the same observed authentication
evidence. Apply, submit, payment, deletion and sign-out links remain forbidden.
No password entry, MFA handling or external submission is added. A sign-in
challenge still requires the owner to renew the portal session.

Review continuation: canonical apex/www redirects may expose the same-origin
account entry. Public sign-in prompts may follow that one safe link, but visible
password forms cannot. Fragment-only anchors are skipped. Read/write syncs keep
the observed account destination, and standalone writes use the same observed
access gate. Five regressions failed before repair; all 47 portal tests and
the full static prepush passed afterward. No external form was submitted.

## Render and credential-binding correction

The post-1767 audit 35406757744 reproduced two concrete defects: the LEIC
portal was sent to a parent-domain saved login homepage, and the MTSU sign-in
page was observed with zero characters at DOMContentLoaded. A clean anonymous
browser read showed MTSU rendering its Campus ID link after two seconds.

The reader now allows a bounded three-second render wait only for an empty
page, and at most two visible safe same-origin account GETs (Login then Campus
ID). Password forms, foreign links, submission actions and blocks still stop
access. Parent-domain fallback credentials cannot redirect or widen a child
portal session; an explicitly bound same-portal federated login is preserved.
Six new regressions failed before the change. All 55 related portal tests pass.
Authentication still requires observed logout and account controls, not a
saved-session flag, a readable public page, a successful HTTP response, or a
login-link click. A fresh exact-release live audit remains mandatory.

Review closure: unbound login URLs are restricted to the portal registrable
domain. A parent public homepage is refused, while an exact saved sibling
login host is preserved without granting arbitrary sibling-tenant access.
The registry-selected MTSU connector now shares bounded render/account-entry
observation with the generic connector, reads only the observed account page,
and rejects public or expired-session results before persistence.
