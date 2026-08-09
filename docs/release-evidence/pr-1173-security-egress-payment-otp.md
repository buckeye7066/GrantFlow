# PR 1173 Release Evidence

## Scope

This change set closes three bounded security defects:

1. Four migrated paths that request untrusted or discovered URLs, `portalCheckService`, `linkVerificationService`, `nationalPrograms/fetcher`, and `housingScholarshipCrawler`, now use an SSRF egress chokepoint that validates every redirect hop, pins the policy-approved DNS address to the socket, preserves caller cancellation, enforces one end-to-end deadline across the entire redirect chain, caps response bytes, releases discarded bodies, normalizes redirect methods, and strips credentials across origins.
2. Hamilton payment authorization caps and revocation are rechecked atomically in the recording update so concurrent charges cannot exceed the approved envelope.
3. Verification codes use `crypto.randomInt` rather than `Math.random`.

## Verified base and candidate

- Current base during final synchronization: `main@4f4aa567d0e86500ff682d54a4855a72105dead3`
- Final verified source candidate before this evidence-only commit: `8ccb2f8139f89d2aa36296d3add7372ecbf2bf82`
- Pull request: #1173
- Rollback point: `main@4f4aa567d0e86500ff682d54a4855a72105dead3`

## Verification completed on the candidate

Verification completed successfully on Node 20.20.2 and performed:

- `npm ci --include=optional`
- `node scripts/check-env-examples.mjs`
- focused SSRF, redirect, DNS-pinning, cancellation, end-to-end redirect-deadline, response-cap, payment-cap, revocation, OTP, link-backlog, quarantine, restoration, and retirement regressions
- `npm run check:prepush`

The link-lifecycle tests now inject their hermetic fetch transport explicitly through service options. Production retains the pinned `node-fetch` transport, while tests no longer bypass or impersonate that production choice through a global mock. The temporary repair workflow removed itself before the final source candidate was recorded.

## Safety boundaries

- A policy refusal remains a skipped/unverified URL, not evidence that an opportunity is broken.
- Redirected credentials are retained only for the same origin.
- TLS SNI is preserved for hostnames and omitted for IP literals.
- The per-probe timeout is one deadline for DNS validation and all redirect hops; it is not renewed after a redirect.
- The response-size cap is enforced while streaming rather than after an unbounded read.
- Production call sites use the pinned transport unless a caller deliberately supplies an alternate implementation. The current alternate-transport uses are explicit test seams.
- This PR protects only the four migrated paths named above. `stateOpenDataConnector`, `ecfBenefitsCrawler`, and `nationalZipCrawler` still accept configurable or discovered destinations through axios-based request paths and require a separate pinned-transport review and migration before equivalent SSRF protection can be claimed for them.
- Hardcoded provider clients were not migrated merely to inflate coverage; each remains subject to its existing fixed-endpoint trust boundary and should be re-reviewed if its URL becomes configurable.

## Release decision

Merge only after ordinary pull-request CI, CodeQL, automated review, and the Vercel preview succeed on this evidence-commit head. After merge, verify that Vercel and Railway deploy the exact merge SHA and run the production health and authenticated smoke journeys required by the GrantFlow release process.
