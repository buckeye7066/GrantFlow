# Owner runtime review closure

This continuation addresses the six remaining review findings on PR 1764.

- Durable owner jobs use the same configured JWT key resolution as authentication.
- Recovered work validates current database-backed owner authority before inference.
  Deleted, demoted, invalid-proof, and unavailable-database cases fail closed.
- HTTP crawler job responses and Anya admin job results omit internal billing proofs.
- Cold-login scheduling establishes scope from the verified stored account, not the
  pre-authentication request context or an operator-supplied role claim.
- Manual and automatic retries preserve the original signed billing identity.
  Retrying customer work as the owner does not spend the owner's subscription.
- Alias repair updates the profile binding and validated signed intent atomically.

Eight targeted behavioral regressions failed before the changes and passed after.
Related queue/retry/dispatcher tests passed, including actual durable job execution.
The complete static and exact-head CI gates remain binding for the release.

No production user records, login methods, subscriptions, payments, or funder
submissions were changed by this patch. No acceptance threshold was relaxed.
