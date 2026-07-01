-- Migration 0130: profiles.preferred_language
--
-- The profile's chosen language as a short code (e.g. 'ru', 'es'). NULL / 'en'
-- means English-only. Drives the global bilingual-documents rule: every packet
-- Hamilton generates is saved in English AND, when this column names a
-- non-English language, a translated copy in that language.
--
-- Idempotent; also re-asserted on every boot by
-- ensureSchemaInvariants.ensureProfilePreferredLanguageColumn so a skipped
-- migrate-on-boot cannot 500 the packet generator.

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS preferred_language TEXT;
