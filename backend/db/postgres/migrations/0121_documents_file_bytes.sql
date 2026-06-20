-- Durable document byte storage (mirrors the avatar_data BYTEA pattern).
--
-- Generated application PACKETS (the printable mail/fax/email packet Hamilton
-- builds for non-portal funders) must persist as real Documents. Railway's
-- filesystem is ephemeral, so storing only a /uploads path would lose the file
-- on the next redeploy. Keep the bytes in Postgres so a saved packet always
-- downloads, regardless of disk state.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS file_bytes BYTEA;
