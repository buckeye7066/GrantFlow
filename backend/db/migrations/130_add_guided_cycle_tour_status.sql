-- Migration: guided first-cycle tour status
--
-- Tracks the new post-intake guided walkthrough (crawl -> choose funding
-- source -> pipeline -> stage advance -> Hamilton portal watch), distinct
-- from the older AnyaGuidedTour modal's last_completed_tour_version.
--
-- NULL   = not eligible (pre-existing user, or any non-intake account
--          creation path) -- never shown the new tour.
-- 'pending'   = set exactly once, at the moment a brand-new user finishes
--               Anya's intake interview (backend/routes/onboarding.js).
-- 'completed' = user finished the guided tour.
-- 'skipped'   = user dismissed it early.

ALTER TABLE users ADD COLUMN guided_cycle_tour_status TEXT DEFAULT NULL;
