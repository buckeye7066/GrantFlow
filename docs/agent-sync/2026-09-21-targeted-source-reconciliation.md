# Targeted source refresh preserves unqueried results

The admin source refresh narrows discovery with `onlySourceIds`, but persistence previously reconciled the whole primary profile. A one-source refresh could therefore delete accepted awards from unrelated sources it never queried.

The service now selects evaluated-pair reconciliation for a nonempty source restriction. Persistence follows canonical ID remapping and replaces only evaluated primary pairs, including explicit REJECTs. Omitted pairs remain intact. Normal full-discovery reconciliation and secondary-profile additive matching retain their existing behavior. The integrity sweep still enforces invalid/rejected evidence.

Validation: two SQLite regressions failed before the fix and passed after it (empty and explicitly rejecting targeted runs). A live service test discovers an accepted award through one stubbed source, refreshes another source, and verifies the original persisted match remains unchanged. Crawler OS family: 59 passed. Independent review found no blocking regression. Production verification is pending deployment; no claim of restored coverage is made from local tests.
