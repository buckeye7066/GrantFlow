-- Migration: opportunity_embeddings sidecar table (SEMANTIC_RECALL feature).
--
-- Stores one embedding vector per funding_opportunities row so semantic
-- retrieval can ADD candidates into the canonical matcher's candidate scan.
-- Vectors are stored as JSON text (portable path); cosine similarity is
-- computed in JS over a bounded scan. The Postgres migration additionally
-- adds an optional pgvector column when the extension is available.
--
-- Embeddings NEVER change a match decision — matchEngine remains the sole
-- scoring/decision authority (docs/canonical_rules.md, "Rules over score").

CREATE TABLE IF NOT EXISTS opportunity_embeddings (
  opportunity_id TEXT PRIMARY KEY REFERENCES funding_opportunities(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  dims INTEGER NOT NULL,
  vector TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_opportunity_embeddings_updated
  ON opportunity_embeddings(updated_at);
