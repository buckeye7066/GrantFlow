-- Migration 128: allow profile-reviewed live web leads to keep web_search provenance.
--
-- SQLite dev databases do not enforce/alter the production CHECK constraint here.
-- The canonical runtime list lives in backend/utils/recordOrigins.js and fresh
-- SQLite DBs inherit the updated schema.sql.
SELECT 1;
