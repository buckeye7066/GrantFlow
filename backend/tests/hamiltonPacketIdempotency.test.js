import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { _internal } from '../services/hamilton/hamiltonApplicationPacketGenerator.js'

const { insertDocumentRecord } = _internal

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE documents (
      id TEXT PRIMARY KEY,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      organization_id TEXT, grant_id TEXT, profile_id TEXT,
      university_application_id TEXT, university_application_name TEXT,
      name TEXT, type TEXT, file_url TEXT, file_path TEXT, file_size INTEGER,
      mime_type TEXT, file_bytes BLOB, extracted_text TEXT, processing_status TEXT, notes TEXT
    );
    CREATE TABLE profile_documents (profile_id TEXT, document_id TEXT, PRIMARY KEY(profile_id, document_id));
  `)
  return db
}

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

describe('Hamilton generated-document idempotency safeguard', () => {
  it('regenerating the same source+format REUSES the row (no duplicate) and keeps the latest bytes', async () => {
    const db = makeDb()
    const base = {
      profileId: 'p1', grantId: 'g1', name: 'HOPE Scholarship — DOCX',
      type: 'hamilton_generated_application', mimeType: DOCX,
    }
    const id1 = await insertDocumentRecord(db, { ...base, filePath: '/tmp/a.docx', fileSize: 10, fileBytes: Buffer.from('v1') })
    const id2 = await insertDocumentRecord(db, { ...base, filePath: '/tmp/b.docx', fileSize: 20, fileBytes: Buffer.from('v2') })

    expect(id2).toBe(id1) // same row reused across runs
    const rows = db.prepare("SELECT id, file_size, file_path FROM documents WHERE type='hamilton_generated_application'").all()
    expect(rows).toHaveLength(1) // ONE doc, not two
    expect(rows[0].file_size).toBe(20) // updated in place to the latest
    expect(rows[0].file_path).toBe('/tmp/b.docx')
    expect(db.prepare('SELECT count(*) AS c FROM profile_documents').get().c).toBe(1) // link not duplicated
  })

  it('keeps DOCX and PDF of the same source as separate rows (dedup is per format)', async () => {
    const db = makeDb()
    const common = { profileId: 'p1', grantId: 'g1', type: 'hamilton_generated_application' }
    await insertDocumentRecord(db, { ...common, name: 'HOPE — DOCX', mimeType: DOCX, fileBytes: Buffer.from('d') })
    await insertDocumentRecord(db, { ...common, name: 'HOPE — PDF', mimeType: 'application/pdf', fileBytes: Buffer.from('p') })
    const rows = db.prepare("SELECT * FROM documents WHERE type='hamilton_generated_application'").all()
    expect(rows).toHaveLength(2)
  })

  it('does not collapse across different profiles', async () => {
    const db = makeDb()
    const base = { grantId: 'g1', name: 'HOPE — DOCX', type: 'hamilton_generated_application', mimeType: DOCX, fileBytes: Buffer.from('x') }
    await insertDocumentRecord(db, { ...base, profileId: 'p1' })
    await insertDocumentRecord(db, { ...base, profileId: 'p2' })
    expect(db.prepare("SELECT count(*) AS c FROM documents").get().c).toBe(2)
  })
})
