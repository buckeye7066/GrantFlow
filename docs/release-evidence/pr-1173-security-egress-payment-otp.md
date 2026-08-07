# PR 1173 Release Evidence

## Scope

This change set closes three bounded security defects:

1. Outbound requests derived from untrusted or discovered URLs now use an SSRF egress chokepoint that validates every redirect hop, pins the policy-approved DNS address to the socket, preserves caller cancellation, caps time and response bytes, releases discarded bodies, normalizes redirect methods, and strips credentials across origins.
2. Hamilton payment authorization caps and revocation are rechecked atomically in the recording update so concurrent charges cannot exceed the approved envelope.
3. Verification codes use `crypto.randomInt` rather than `Math.random`.

## Verified base and candidate

- Current base during final synchronization: `main@4f4aa567d0e86500ff682d54a4855a72105dead3`
- Synchronized candidate before this evidence-only commit: `bd27489ee5c00affe265ebf56d89ef603fd75dd5`
- Pull request: #1173
- Rollback point: `main@4f4aa567d0e86500ff682d54a4855a72105dead3`

## Verification completed on the synchronized candidate

The final synchronization workflow completed successfully on Node 20.20.2 and performed:

- `npm ci --include=optional`
- `node scripts/check-env-examples.mjs`
- focused SSRF, redirect, DNS-pinning, cancellation, response-cap, payment-cap, revocation, and OTP regressions
- `npm run check:prepush`

The branch was merged with current `main` before those checks and the temporary synchronization workflow removed itself before publishing the candidate.

## Safety boundaries

- A policy refusal remains a skipped/unverified URL, not evidence that an opportunity is broken.
- Redirected credentials are retained only for the same origin.
- TLS SNI is preserved for hostnames and omitted for IP literals.
- The response-size cap is enforced while streaming rather than after an unbounded read.
- The PR does not claim that every outbound call site has been migrated; hardcoded provider clients and remaining axios-based untrusted-input paths require separate review.

## Release decision

Merge only after ordinary pull-request CI, automated review, and the Vercel preview succeed on the evidence-commit head. After merge, verify that Vercel and Railway deploy the exact merge SHA and run the production health and authenticated smoke journeys required by the GrantFlow release process.
