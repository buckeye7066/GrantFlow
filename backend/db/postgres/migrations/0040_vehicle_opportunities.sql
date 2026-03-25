-- Vehicle Opportunities pipeline table (PostgreSQL).
-- Stores vehicle listings ingested via POST /api/vehicles/ingest.
CREATE TABLE IF NOT EXISTS vehicle_opportunities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_type TEXT NOT NULL,
  title TEXT NOT NULL,
  price NUMERIC,
  mileage INTEGER,
  year INTEGER,
  transmission TEXT,
  color TEXT,
  location TEXT,
  link TEXT NOT NULL,
  vin TEXT,
  clean_title BOOLEAN DEFAULT TRUE,
  source TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT vehicle_opportunities_link_unique UNIQUE (link)
);

CREATE INDEX IF NOT EXISTS idx_vehicle_opportunities_created_at ON vehicle_opportunities(created_at);
