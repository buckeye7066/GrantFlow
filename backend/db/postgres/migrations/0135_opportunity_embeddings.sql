-- Migration: opportunity_embeddings sidecar table (SEMANTIC_RECALL feature).
--
-- Portable core: JSON-text vector column + brute-force cosine in JS.
-- Optional acceleration: when the pgvector extension is available we add an
-- `embedding vector(1536)` column + cosine index; the runtime probes for the
-- column and silently uses the JSON path when it is absent. Every pgvector
-- statement below is guarded so this migration NEVER fails on a database
-- without the extension (the CLI runner is strict on Postgres by design).

CREATE TABLE IF NOT EXISTS opportunity_embeddings (
  opportunity_id TEXT PRIMARY KEY REFERENCES funding_opportunities(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  dims INTEGER NOT NULL,
  vector TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_opportunity_embeddings_updated
  ON opportunity_embeddings(updated_at);

-- Guarded pgvector enablement: degrade to the JSON path when unavailable.
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS vector;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pgvector extension unavailable (%). Semantic recall will use the portable JSON vector path.', SQLERRM;
  END;

  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    BEGIN
      ALTER TABLE opportunity_embeddings ADD COLUMN IF NOT EXISTS embedding vector(1536);
      CREATE INDEX IF NOT EXISTS idx_opportunity_embeddings_vec
        ON opportunity_embeddings USING ivfflat (embedding vector_cosine_ops);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'pgvector column/index setup failed (%). Semantic recall will use the portable JSON vector path.', SQLERRM;
    END;
  END IF;
END $$;
