-- Document ingestion: canonical extracted text + provenance + confidence

CREATE TABLE IF NOT EXISTS document_extracts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,

  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','ready','failed')),
  source_type TEXT CHECK(source_type IN ('docx','pdf','image','text')),
  methods_used JSONB NOT NULL DEFAULT '[]'::jsonb,
  pages INTEGER,
  char_count INTEGER NOT NULL DEFAULT 0,
  word_count INTEGER NOT NULL DEFAULT 0,
  text TEXT,
  ocr_text TEXT,
  warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
  confidence DOUBLE PRECISION NOT NULL DEFAULT 0.0,
  provenance JSONB,
  file_hash TEXT,
  ocr_used BOOLEAN NOT NULL DEFAULT FALSE,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(document_id)
);

CREATE INDEX IF NOT EXISTS idx_document_extracts_document_id ON document_extracts(document_id);
CREATE INDEX IF NOT EXISTS idx_document_extracts_status ON document_extracts(status);
CREATE INDEX IF NOT EXISTS idx_document_extracts_file_hash ON document_extracts(file_hash);

