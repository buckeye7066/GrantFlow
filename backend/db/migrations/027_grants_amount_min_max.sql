-- Add amount_min and amount_max to grants for UI/API compatibility (pipeline cards, GrantForm, Reports).
-- Fixes: "column amount_max does not exist" on Grant Detail / AI Proposal Coach and related 500s.
-- SQLite: run once; app also ensures columns at runtime via ensureGrantAiColumns in grants.js.

ALTER TABLE grants ADD COLUMN amount_min REAL;
ALTER TABLE grants ADD COLUMN amount_max REAL;
