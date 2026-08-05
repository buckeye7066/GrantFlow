-- @sqlite-continue-on-idempotent-errors
-- Forward repair for databases that already stamped migration 122 before
-- match_confidence became part of its canonical shape. Read-only funding-source
-- routes select this column before any Crawler OS persistence path runs, so the
-- schema itself must own it; a runtime ensure/persist side effect is not a safe
-- prerequisite for reading existing matches.

ALTER TABLE profile_opportunity_matches ADD COLUMN match_confidence REAL;
