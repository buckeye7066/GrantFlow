-- Durable avatar storage.
--
-- Avatars were written only to the container's local filesystem (/uploads/...)
-- with just the path stored in profiles.avatar_url. On Railway the filesystem
-- is ephemeral, so every redeploy wiped the image; a boot self-heal then NULLed
-- avatar_url because the file was gone. Net effect: profile pictures never
-- survived a restart. Store the bytes in Postgres so they persist.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS avatar_data BYTEA;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS avatar_content_type TEXT;
