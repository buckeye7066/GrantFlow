-- Document ingestion: canonical extracted text + provenance + confidence

CREATE TABLE IF NOT EXISTS document_extracts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,

  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','ready','failed')),
  source_type TEXT CHECK(source_type IN ('docx','pdf','image','text')),
  methods_used TEXT DEFAULT '[]', -- JSON array (e.g. ["pdf_text","ocr"])
  pages INTEGER,
  char_count INTEGER DEFAULT 0,
  word_count INTEGER DEFAULT 0,
  text TEXT,
  ocr_text TEXT,
  warnings TEXT DEFAULT '[]', -- JSON array
  confidence REAL DEFAULT 0.0,
  provenance TEXT, -- JSON
  file_hash TEXT,
  ocr_used BOOLEAN DEFAULT 0,
  started_at DATETIME,
  finished_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  UNIQUE(document_id)
);

CREATE INDEX IF NOT EXISTS idx_document_extracts_document_id ON document_extracts(document_id);
CREATE INDEX IF NOT EXISTS idx_document_extracts_status ON document_extracts(status);
CREATE INDEX IF NOT EXISTS idx_document_extracts_file_hash ON document_extracts(file_hash);

