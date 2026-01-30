-- Migration 0028: Add item_catalog table for AI item suggestions + discovery (Postgres)
-- Date: 2026-01-30

CREATE TABLE IF NOT EXISTS item_catalog (
  id TEXT PRIMARY KEY DEFAULT (gen_random_uuid()::text),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  active BOOLEAN DEFAULT TRUE,
  name TEXT NOT NULL,
  category TEXT,
  synonyms TEXT DEFAULT '[]',
  tags TEXT DEFAULT '[]',
  source TEXT DEFAULT 'curated' CHECK(source IN ('curated', 'anya_discovered', 'manual')),
  evidence_url TEXT,
  notes TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_item_catalog_name ON item_catalog(name);
CREATE INDEX IF NOT EXISTS idx_item_catalog_active ON item_catalog(active);

