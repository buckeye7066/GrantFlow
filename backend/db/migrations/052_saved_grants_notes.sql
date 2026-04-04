-- 052_saved_grants_notes.sql
-- Add notes column to saved_grants for user annotations
ALTER TABLE saved_grants ADD COLUMN IF NOT EXISTS notes TEXT DEFAULT NULL;
