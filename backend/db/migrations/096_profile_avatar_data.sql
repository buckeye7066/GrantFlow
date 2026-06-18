-- Durable avatar storage (SQLite parity with
-- backend/db/postgres/migrations/0092_profile_avatar_data.sql).
-- Store the image bytes in the DB so they are not lost when the local
-- /uploads directory is wiped. Idempotent via the migrate runner's
-- "duplicate column" => already-applied handling.
ALTER TABLE profiles ADD COLUMN avatar_data BLOB;
ALTER TABLE profiles ADD COLUMN avatar_content_type TEXT;
