-- 0053: Keep Postgres migration numbering aligned with SQLite repair.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
