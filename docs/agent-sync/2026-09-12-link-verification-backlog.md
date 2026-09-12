# Link verification backlog recovery

The September 12 vault handoff reports that GrantFlow's production gate fails
because only 85.7% of the complete visible catalog is freshly verified. The
95% catalog threshold and 100% direct opportunity requirement remain in force.

The recurring candidate query placed every broken pointer and unexplained
hidden success ahead of overdue rows. A recent failed probe therefore selected
the same active pointer again while thousands of older links never got a slot.
The query now orders by verification age first, with status used only for ties.
Each real persisted attempt moves that row behind the remaining backlog.

Recovery uses two concurrent probes with a two-second batch delay. OSM requests
identify GrantFlow instead of using the optional browser identity. The OSM
[usage policy](https://operations.osmfoundation.org/policies/api/) calls for an
identifying User-Agent and at most two download threads. No freshness timestamp
is advanced without the normal verifier's actual probe and audit event.

Regression tests exercise consecutive bounded batches against both recently
broken pointers and hidden successes. Both new cases failed with the old query;
the targeted lifecycle suites passed after the ordering fix. The pre-push
checks also passed before the additional conservative concurrency adjustment.
Production recovery and release verification must be measured after deployment.
