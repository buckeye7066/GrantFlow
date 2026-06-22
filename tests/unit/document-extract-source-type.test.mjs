import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'

import {
  ensureDocumentExtract,
  getDocumentExtract,
  assertValidSourceType,
  isValidSourceType,
  normalizeSourceType,
  ALLOWED_SOURCE_TYPES,
} from '../../backend/services/documentIngestion/documentExtractStore.js'
import { sanitizeDbErrorMessage } from '../../backend/utils/sanitizeDbError.js'

// Build a SQLite document_extracts table WITH the real CHECK constraint so the
// test actually exercises the constraint the production bug tripped:
//   document_extracts_source_type_check (source_type IN docx|pdf|image|text).
async function withTempSqliteDb() {
  const dir = await fsp.mkdtemp(join(os.tmpdir(), 'grantflow-doc-extract-'))
  const dbPath = join(dir, 'test.db')
  const db = new Database(dbPath)

  db.exec(`
    PRAGMA foreign_keys = OFF;

    CREATE TABLE document_extracts (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','processing','ready','failed')),
      source_type TEXT CHECK(source_type IN ('docx','pdf','image','text')),
      methods_used TEXT DEFAULT '[]',
      pages INTEGER,
      char_count INTEGER DEFAULT 0,
      word_count INTEGER DEFAULT 0,
      text TEXT,
      ocr_text TEXT,
      warnings TEXT DEFAULT '[]',
      confidence REAL DEFAULT 0.0,
      provenance TEXT,
      file_hash TEXT,
      ocr_used BOOLEAN DEFAULT 0,
      started_at DATETIME,
      finished_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(document_id)
    );
  `)

  return {
    db,
    close: async () => {
      try {
        db.close()
      } finally {
        await fsp.rm(dir, { recursive: true, force: true })
      }
    },
  }
}

test('source_type validation: allowed set + isValidSourceType', () => {
  assert.deepEqual([...ALLOWED_SOURCE_TYPES], ['docx', 'pdf', 'image', 'text'])
  for (const v of ['docx', 'pdf', 'image', 'text']) assert.ok(isValidSourceType(v))
  assert.ok(isValidSourceType(null)) // CHECK permits NULL
  // After normalization, web/text-ish values become 'text' (valid).
  assert.equal(normalizeSourceType('html'), 'text')
  assert.equal(normalizeSourceType('url'), 'text')
  assert.equal(normalizeSourceType('unknown'), 'text')
  assert.equal(normalizeSourceType(null), null)
})

test('assertValidSourceType remaps a URL/web source to a constraint-safe value with no raw DB text', () => {
  // 'html' is what a URL import (www.focusforwardministry.com) detects.
  const normalized = assertValidSourceType('html')
  assert.equal(normalized, 'text')
  // It must never throw with a raw constraint name for a legitimate web import.
})

test('a valid URL import inserts successfully (source_type clamped to text, no constraint violation)', async () => {
  const { db, close } = await withTempSqliteDb()
  try {
    // URL import path passes detected.source_type === 'html'; the store must
    // remap it to a constraint-safe value rather than tripping the CHECK.
    const row = await ensureDocumentExtract(db, {
      documentId: 'doc-url-1',
      sourceType: 'html',
      fileHash: null,
    })
    assert.ok(row, 'extract row should be created')
    const persisted = await getDocumentExtract(db, 'doc-url-1')
    assert.equal(persisted.source_type, 'text')
    assert.equal(persisted.status, 'pending')
  } finally {
    await close()
  }
})

test('valid pdf source_type inserts unchanged', async () => {
  const { db, close } = await withTempSqliteDb()
  try {
    await ensureDocumentExtract(db, { documentId: 'doc-pdf-1', sourceType: 'pdf', fileHash: 'abc' })
    const persisted = await getDocumentExtract(db, 'doc-pdf-1')
    assert.equal(persisted.source_type, 'pdf')
  } finally {
    await close()
  }
})

test('sanitizeDbErrorMessage hides the raw document_extracts CHECK violation from the UI', () => {
  // The exact production leak the owner observed.
  const raw =
    "new row for relation \"document_extracts\" violates check constraint \"document_extracts_source_type_check\""
  const friendly = sanitizeDbErrorMessage(new Error(raw))
  assert.equal(friendly, "Couldn't import or parse this source.")
  // Must NOT leak relation/constraint names.
  assert.ok(!/document_extracts/.test(friendly))
  assert.ok(!/constraint/i.test(friendly))
  assert.ok(!/relation/i.test(friendly))
})

test('sanitizeDbErrorMessage also catches a pg SQLSTATE 23514 (check_violation)', () => {
  const err = new Error("violates check constraint \"document_extracts_source_type_check\"")
  err.code = '23514'
  const friendly = sanitizeDbErrorMessage(err)
  assert.equal(friendly, "Couldn't import or parse this source.")
})

test('sanitizeDbErrorMessage preserves a genuinely user-facing message', () => {
  const msg = 'No readable text could be extracted. Try re-uploading a clearer file.'
  assert.equal(sanitizeDbErrorMessage(new Error(msg)), msg)
})
