# ChatGPT portfolio production readiness

**Executor:** ChatGPT  
**Updated:** 2026-08-12  
**ACTIVE_APP:** GrantFlow  

This board is a coordination record, not release evidence. Exactly one program
is active. Programs after GrantFlow are inventory-only and have not been
audited, edited, tested, or assigned a release status by this execution.

| Program | Queue | Purpose | Repository | Deployment or package | Branch or worktree | Current phase | Tests | Review | Merge | Deploy | Live verification | Blockers | Status |
|---|---:|---|---|---|---|---|---|---|---|---|---|---|---|
| **GrantFlow (ACTIVE_APP)** | 1 | Whole-profile funding discovery and honest application workflow | `buckeye7066/GrantFlow` (`main`) | Vercel frontend and Railway backend; current identities require connector verification | `/workspace/GrantFlow`; local branch `work`; baseline `b6663ef939863d97f3fd9ffe468b3302f22e72df` | AUDITING | `npm test`: metadata, lint, typecheck, and build passed; unit phase interrupted after repeated external liveness timeouts | Fresh final-candidate review required | PR #1194 is present in local history; current remote/PR state unavailable | Exact deployed SHA unavailable | Authenticated journey and real-output comparison unavailable | Checkout has no Git remote; GitHub CLI is unauthenticated; no Vercel/Railway/authenticated-production connector is exposed | AUDITING |
| Axiom GeneMap Discovery | 2 | Genetics education and early research with evidence provenance | `buckeye7066/genemap-discovery` (`main`) | `https://genemap-discovery.vercel.app` (unverified) | Not opened | INVENTORY | Not run | Not started | Not inspected | Not inspected | Not run | GrantFlow ACTIVE_APP lock | INVENTORY |
| SermonSmith AI by Axiom BioLabs | 3 | Pastor-led, source-faithful sermon workspace | `buckeye7066/sermonsmith` (`main`) | Vercel/Railway identities unverified | Not opened | INVENTORY | Not run | Not started | Not inspected | Not inspected | Not run | GrantFlow ACTIVE_APP lock | INVENTORY |
| PromoPilot | 4 | Approval-first, brand-isolated marketing control plane | `buckeye7066/promopilot` (`master`) | Railway identity unverified | Not opened | INVENTORY | Not run | Not started | Not inspected | Not inspected | Not run | GrantFlow ACTIVE_APP lock | INVENTORY |
| LiveHealth | 5 | Safely scoped healthcare records and operations platform | `buckeye7066/livehealth` (`main`) | Launcher/deployment unverified | Not opened | INVENTORY | Not run | Not started | Not inspected | Not inspected | Not run | GrantFlow ACTIVE_APP lock | INVENTORY |
| DirectShift Health | 6 | Evidence-backed healthcare staffing marketplace | `buckeye7066/directshift-health` (`main`) | `start-directshift.cmd` (not accessible or verified) | Not opened | INVENTORY | Not run | Not started | Not inspected | Not inspected | Not run | GrantFlow ACTIVE_APP lock | INVENTORY |
| Mind Over Math | 7 | Invite-controlled math learning with deterministic verification | `buckeye7066/mind-over-math` (`main`) | Vercel/Railway identities unverified | Not opened | INVENTORY | Not run | Not started | Not inspected | Not inspected | Not run | GrantFlow ACTIVE_APP lock | INVENTORY |
| FutureU | 8 | Complete, reviewed K-12 homeschool and classroom platform | `buckeye7066/FutureU` (`main`) | Local launcher/production host unverified | Not opened | INVENTORY | Not run | Not started | Not inspected | Not inspected | Not run | GrantFlow ACTIVE_APP lock | INVENTORY |

## Execution lock

GrantFlow remains the sole ACTIVE_APP until it is either `PRODUCTION READY` or
all connector-accessible work is complete and its remaining blocker is
precisely evidenced. No other listed repository may be opened or changed while
this lock remains active.

## Current source-of-truth limitation

The local checkout contains no configured Git remote, and `gh auth status`
reports no authenticated GitHub host. Therefore the local history supports a
baseline audit, but does not independently verify the current GitHub default
branch, open pull requests, branch protection, CI, or deployments. Those items
remain unknown rather than inferred from the existing readiness report.
