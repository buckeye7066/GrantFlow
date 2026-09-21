# Empty targeted source scope

Targeted source runs now pass their primary profile explicitly even when no match rows are returned. Without that caller context, persistence inferred an empty profile list and the integrity sweep interpreted it as global scope. The live-service regression failed before the fix and passed after: an empty refresh preserves both its own omitted accepted award and an unrelated profile's existing row. Full-discovery defaults are unchanged. Resource, cross-profile, and pointer regression suites: 31 passed. Independent review found no blockers.
