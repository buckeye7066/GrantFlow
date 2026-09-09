-- Additive owner advertisements; no seed data or profile references.
CREATE TABLE IF NOT EXISTS advertisements (
  id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, advertiser TEXT NOT NULL,
  headline TEXT NOT NULL, body TEXT NOT NULL, target_url TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL CHECK(duration_seconds BETWEEN 5 AND 300),
  starts_at TEXT NOT NULL, ends_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('published', 'paused', 'removed')),
  image_mime TEXT NOT NULL, image_base64 TEXT NOT NULL, image_hash TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS advertisement_events (
  ad_id TEXT NOT NULL REFERENCES advertisements(id), viewer_hash TEXT NOT NULL,
  day TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('impression', 'click')),
  bucket TEXT NOT NULL, created_at TEXT NOT NULL, ticket_hash TEXT NOT NULL,
  UNIQUE(ticket_hash, kind),
  PRIMARY KEY(ad_id, viewer_hash, day, kind, bucket)
);
CREATE TABLE IF NOT EXISTS advertisement_view_tickets (
  ticket_hash TEXT PRIMARY KEY, ad_id TEXT NOT NULL REFERENCES advertisements(id),
  viewer_hash TEXT NOT NULL, issued_ms TEXT NOT NULL, expires_ms TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS advertisement_events_daily ON advertisement_events(ad_id, day, kind);
