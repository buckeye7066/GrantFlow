# Preserve Amy's acceptance learning evidence

The canonical exact-50 command intentionally measures in a disposable database
with learning and tuning disabled. Its receipt previously omitted the
archetype metrics and proposed query-steering lessons Amy had derived. Cleanup
therefore discarded evidence needed to teach a subsequent run.

The receipt now retains `amy.learning_handoff`: run identity, proposed updates,
per-archetype metrics, and the search coverage that distinguishes healthy
observations from uncertain ones. Missing evidence is explicitly null with
`recorded: false`; it is never represented as a healthy empty update. The
producer exposes the same search coverage used by its existing learning store.

`applied` remains false. Recording a handoff does not mean the production
learner consumed it. Acceptance still disables learning/tuning, uses the same
50 profiles and passing criteria, and deletes its disposable data. Any later
application must retain the existing minimum evidence and uncertain-archetype
rules; provider outages cannot be treated as proof of a search coverage gap.

This is an additive receipt field. Existing receipt consumers and pass/fail
checks are unchanged. Tests verify evidence survives receipt serialization and
database cleanup, and missing evidence remains distinguishable.
