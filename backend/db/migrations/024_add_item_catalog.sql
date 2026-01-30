-- Migration 024: Add item_catalog table for AI item suggestions + discovery
-- Date: 2026-01-30

CREATE TABLE IF NOT EXISTS item_catalog (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  active BOOLEAN DEFAULT TRUE,
  name TEXT NOT NULL,
  category TEXT,
  synonyms TEXT DEFAULT '[]', -- JSON array
  tags TEXT DEFAULT '[]', -- JSON array
  source TEXT DEFAULT 'curated' CHECK(source IN ('curated', 'anya_discovered', 'manual')),
  evidence_url TEXT,
  notes TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_item_catalog_name ON item_catalog(name);
CREATE INDEX IF NOT EXISTS idx_item_catalog_active ON item_catalog(active);

