-- 036: Add match decision metadata columns
-- Adds structured match decision tracking to grants pipeline, funding_opportunities, and profiles.

-- grants table: store full match decision per pipeline entry
ALTER TABLE grants ADD COLUMN match_decision TEXT;
ALTER TABLE grants ADD COLUMN match_explanation TEXT;
ALTER TABLE grants ADD COLUMN matched_needs TEXT DEFAULT '[]';
ALTER TABLE grants ADD COLUMN eligibility_status TEXT;
ALTER TABLE grants ADD COLUMN ineligibility_reasons TEXT DEFAULT '[]';
ALTER TABLE grants ADD COLUMN profile_fingerprint TEXT;
ALTER TABLE grants ADD COLUMN opportunity_fingerprint TEXT;
ALTER TABLE grants ADD COLUMN matcher_version TEXT;
ALTER TABLE grants ADD COLUMN evaluated_at DATETIME;
ALTER TABLE grants ADD COLUMN match_confidence INTEGER;

-- funding_opportunities table: store normalized eligibility fields
ALTER TABLE funding_opportunities ADD COLUMN entity_types_allowed TEXT DEFAULT '[]';
ALTER TABLE funding_opportunities ADD COLUMN need_types_supported TEXT DEFAULT '[]';
ALTER TABLE funding_opportunities ADD COLUMN deadline_status TEXT;
ALTER TABLE funding_opportunities ADD COLUMN official_source_type TEXT;
ALTER TABLE funding_opportunities ADD COLUMN source_trust_score INTEGER;
ALTER TABLE funding_opportunities ADD COLUMN opportunity_fingerprint TEXT;

-- profiles table: store fingerprint and cached normalized snapshot
ALTER TABLE profiles ADD COLUMN profile_fingerprint TEXT;
ALTER TABLE profiles ADD COLUMN normalized_snapshot TEXT;
