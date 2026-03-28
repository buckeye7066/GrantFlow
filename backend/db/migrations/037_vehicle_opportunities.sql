-- Vehicle Opportunities pipeline table (SQLite).
-- Stores vehicle listings ingested via POST /api/vehicles/ingest.
CREATE TABLE IF NOT EXISTS vehicle_opportunities (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  vehicle_type TEXT NOT NULL,
  title TEXT NOT NULL,
  price REAL,
  mileage INTEGER,
  year INTEGER,
  transmission TEXT,
  color TEXT,
  location TEXT,
  link TEXT NOT NULL,
  vin TEXT,
  clean_title INTEGER DEFAULT 1,
  source TEXT,
  created_at DATETIME DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vehicle_opportunities_link ON vehicle_opportunities(link);
CREATE INDEX IF NOT EXISTS idx_vehicle_opportunities_created_at ON vehicle_opportunities(created_at);
