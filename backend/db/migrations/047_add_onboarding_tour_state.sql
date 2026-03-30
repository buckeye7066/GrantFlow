-- Migration: Add durable onboarding and tour state to users table
-- Replaces localStorage-only hasSeenOnboarding with backend-persisted fields.

ALTER TABLE users ADD COLUMN has_completed_onboarding BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN onboarding_completed_at TEXT;
ALTER TABLE users ADD COLUMN last_seen_manual_version INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN last_completed_tour_version INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN tour_dismissed_at TEXT;
