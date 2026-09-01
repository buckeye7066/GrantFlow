# Temporary GrantFlow production-readiness agent manifest

Delete this file before final review.

## Intended purpose
GrantFlow must discover legitimate funding opportunities, preserve source provenance and distinct awards, match them accurately to named user profiles, explain fit and risk honestly, and support preparation/application workflows without fabricated links, duplicate collapse, unsafe auto-application, lost persistence, or misleading scores.

## Required work
1. Start from current `main`; record its exact SHA. Read the project brief, purpose/readiness doctrine, deployment configuration, data model, discovery/matching pipeline, profile flow, application workflow, and actual user-facing entrypoints.
2. Inspect recent PRs, issues, commits, Actions, deployments, and review threads. Determine the recurring problems we have been fighting: distinct awards collapsing after “at” or dashes, duplicate identity, broken/unsafe links and quarantine, profile number versus profile name, scoring drift, persistence/schema defects, crawler/discovery versus matching boundaries, maintenance/login state, failing Vercel/Railway deployments, and checks that never actually ran.
3. Reproduce each current blocker against current `main`; do not blindly transplant old PRs. Preserve legitimate distinct awards and source evidence while preventing true duplicates. Do not loosen safety or matching thresholds merely to raise counts.
4. Fix every repository-controlled production blocker you can prove. Add regression tests for each issue, including data migration/persistence and user-visible workflows. Never fabricate grant availability, eligibility, deadlines, award amounts, links, submission status, or profile identity.
5. Run clean install, full unit/integration/browser suites, TypeScript/build/lint, schema and fresh-database migrations, crawler/link safety, deterministic matching baselines, profile/UI journeys, deployment builds, security scans, mobile/platform contracts, and exact-head CI. Treat external portals, credentials, and live deployment ownership honestly.
6. Review the complete diff line by line, delete this manifest, and update the PR with start/final SHAs, recurring issues, exact commands/results, skipped paths, files changed, deployment evidence, external prerequisites, and a precise production decision.

Do not call GrantFlow production-ready while any repository-controlled critical path, data-integrity invariant, review finding, deployment gate, or exact-head check remains unresolved.