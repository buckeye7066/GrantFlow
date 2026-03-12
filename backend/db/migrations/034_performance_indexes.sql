-- Performance indexes for high-frequency queries
CREATE INDEX IF NOT EXISTS idx_fo_source_source_id ON funding_opportunities(source, source_id);
CREATE INDEX IF NOT EXISTS idx_fo_is_loan ON funding_opportunities(is_loan);
CREATE INDEX IF NOT EXISTS idx_fo_state_active_deadline ON funding_opportunities(state, is_active, deadline);
CREATE INDEX IF NOT EXISTS idx_fo_profile_id ON funding_opportunities(profile_id);
CREATE INDEX IF NOT EXISTS idx_geo_crawl_events_run_id ON geo_crawl_events(run_id);
CREATE INDEX IF NOT EXISTS idx_geo_crawl_events_run_ts ON geo_crawl_events(run_id, ts);
CREATE INDEX IF NOT EXISTS idx_fo_geo_opp_id ON funding_opportunity_geo_index(opportunity_id);
