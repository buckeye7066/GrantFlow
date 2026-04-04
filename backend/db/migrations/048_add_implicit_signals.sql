-- 048: Add implicit_signals column to profiles
-- Stores JSON blob of implicit behavioral signals derived from user actions
-- (e.g. saving or applying to grants). Stored as TEXT for SQLite compatibility.
ALTER TABLE profiles ADD COLUMN implicit_signals TEXT;
