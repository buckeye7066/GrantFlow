# PR 1179 Release Evidence

## Scope

This change set aligns GrantFlow's canonical match authority and Discover presentation behavior:

1. Soft relevance failures reduce the canonical score, while directory and referral pointers remain exempt from score penalties that would hide navigation resources.
2. Matching-funds opportunities enter review only after hard applicant and geography gates, so a cost-share flag cannot rescue an out-of-state or otherwise ineligible opportunity.
3. Explicit women-only restrictions use one shared classifier in normalization and strict relevance; non-exclusive women-prioritized wording remains a soft signal.
4. Empty `GRANTFLOW_SOFT_RELEVANCE_PENALTY` values fall back to the model default while an explicit zero remains valid.
5. Discover normalizes supported response envelopes once and preserves ACCEPT, directory/referral, and recovery-flagged rows rather than silently applying a second eligibility trial.

## Verified base and candidate

- Current base during final synchronization: `main@4f4aa567d0e86500ff682d54a4855a72105dead3`
- Synchronized candidate before this evidence-only commit: `58b8b10871f54581176d8d315b777eb0a3a51c79`
- Pull request: #1179
- Rollback point: `main@4f4aa567d0e86500ff682d54a4855a72105dead3`

## Verification completed on the synchronized candidate

The final synchronization workflow completed successfully on Node 20.20.2 and performed:

- `npm ci --include=optional`
- `node scripts/check-env-examples.mjs`
- focused canonical decision, soft-penalty, demographic restriction, opportunity normalization, geography/matching-funds, response-envelope, and Discover catalog regressions
- `npm run check:prepush`

The branch was merged with current `main` before those checks and the temporary synchronization workflow removed itself before publishing the candidate.

## Safety and truth boundaries

- The backend's canonical decision remains authoritative.
- The frontend may apply presentation preferences but cannot silently reject a backend ACCEPT decision.
- Pointer resources remain REVIEW/navigation aids and are not represented as directly eligible awards.
- Matching-funds status is represented as a feasibility review, not fabricated evidence that the applicant can or cannot provide cost share.
- The shared demographic classifier distinguishes explicit exclusivity from prioritization and is regression-tested against both false-negative and false-positive cases.

## Release decision

Merge only after ordinary pull-request CI, CodeQL, automated review, and the Vercel preview succeed on the evidence-commit head. After merge, verify Vercel and Railway on the exact merge SHA, then run the exact-50 Amy/plain-web parity acceptance, canonical score/display reconciliation, link-lifecycle audit, and authenticated production journeys required by the GrantFlow exit criteria.
