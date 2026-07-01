import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { generateAndSavePacket } from '../services/hamilton/hamiltonApplicationPacketGenerator.js'
import { normalizeLanguage, languageNativeLabel, translatePacketContent } from '../services/hamilton/packetTranslation.js'

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
    CREATE TABLE profiles (id TEXT PRIMARY KEY, display_name TEXT, preferred_language TEXT);
  `)
  return db
}

// Deterministic fake translator — marks every string so we can assert the
// translated copy carries translated content (no AI/network in tests).
const fakeTranslate = async (packet, lang) => ({
  title: `[${lang}] ${packet.title}`,
  sections: packet.sections.map((s) => ({ heading: `[${lang}] ${s.heading}`, body: `[${lang}] ${s.body}` })),
  instructions: (packet.instructions || []).map((l) => `[${lang}] ${l}`),
})

const profile = {
  id: 'p-liubov',
  display_name: 'Liubov Samoylenko',
  basic_information: { first_name: 'Liubov', last_name: 'Samoylenko', email: 'anyawhite@rocketmail.com' },
  essays: { primary: 'My personal statement.' },
}
const opportunity = { id: 'opp1', title: 'HOPE Scholarship', funder_name: 'TSAC', deadline: '2026-09-01' }

let storageDir
beforeEach(() => {
  storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-bilingual-'))
  process.env.HAMILTON_PACKET_STORAGE_DIR = storageDir
})
afterEach(() => {
  try { fs.rmSync(storageDir, { recursive: true, force: true }) } catch { /* ignore */ }
  delete process.env.HAMILTON_PACKET_STORAGE_DIR
})

function docNames(db) {
  return db.prepare("SELECT name FROM documents WHERE type='hamilton_generated_application' ORDER BY name").all().map((r) => r.name)
}

describe('Hamilton bilingual-documents rule', () => {
  it('English-only profile: no translated copy, no behavior change', async () => {
    const db = makeDb()
    db.prepare('INSERT INTO profiles (id, display_name, preferred_language) VALUES (?,?,?)').run('p-liubov', 'Liubov', null)
    const res = await generateAndSavePacket(db, { profile, opportunity, automationType: 'mail', translateContent: fakeTranslate })

    expect(res.docx_document_id).toBeTruthy()
    expect(res.translation.language).toBeNull()
    expect(res.translation.docx_document_id).toBeNull()
    // Only the English DOCX (PDF depends on chromium availability) — no "(...)" language-labeled rows.
    expect(docNames(db).some((n) => /\(.+\)/.test(n))).toBe(false)
  })

  it('Russian profile (read from DB column): saves an additional translated DOCX copy', async () => {
    const db = makeDb()
    db.prepare('INSERT INTO profiles (id, display_name, preferred_language) VALUES (?,?,?)').run('p-liubov', 'Liubov', 'ru')
    const res = await generateAndSavePacket(db, { profile, opportunity, automationType: 'mail', translateContent: fakeTranslate })

    expect(res.translation.language).toBe('ru')
    expect(res.translation.docx_document_id).toBeTruthy()
    expect(res.translation.error).toBeNull()

    const names = docNames(db)
    const label = languageNativeLabel('ru') // Русский
    expect(names).toContain(`HOPE Scholarship — DOCX (${label})`)
    expect(names).toContain('HOPE Scholarship — DOCX') // English still present

    // The translated DOCX row stored translated (marked) extracted text.
    const ru = db.prepare("SELECT extracted_text FROM documents WHERE name = ?").get(`HOPE Scholarship — DOCX (${label})`)
    expect(ru.extracted_text).toContain('[ru]')
  })

  it('preferredLanguage override wins over the profile/DB value', async () => {
    const db = makeDb()
    db.prepare('INSERT INTO profiles (id, display_name, preferred_language) VALUES (?,?,?)').run('p-liubov', 'Liubov', null)
    const res = await generateAndSavePacket(db, { profile, opportunity, automationType: 'mail', preferredLanguage: 'es', translateContent: fakeTranslate })
    expect(res.translation.language).toBe('es')
    expect(docNames(db)).toContain(`HOPE Scholarship — DOCX (${languageNativeLabel('es')})`)
  })

  it('translation failure is non-fatal: English packet still saved, error surfaced', async () => {
    const db = makeDb()
    db.prepare('INSERT INTO profiles (id, display_name, preferred_language) VALUES (?,?,?)').run('p-liubov', 'Liubov', 'ru')
    const boom = async () => { throw new Error('provider down') }
    const res = await generateAndSavePacket(db, { profile, opportunity, automationType: 'mail', translateContent: boom })

    expect(res.docx_document_id).toBeTruthy()        // English packet intact
    expect(res.translation.language).toBe('ru')
    expect(res.translation.docx_document_id).toBeNull()
    expect(res.translation.error).toMatch(/provider down/)
  })
})

describe('packetTranslation helpers', () => {
  it('normalizeLanguage treats English/empty as null and normalizes variants', () => {
    expect(normalizeLanguage(null)).toBeNull()
    expect(normalizeLanguage('en')).toBeNull()
    expect(normalizeLanguage('English')).toBeNull()
    expect(normalizeLanguage('ru-RU')).toBe('ru')
    expect(normalizeLanguage('Russian')).toBe('ru')
    expect(normalizeLanguage('es')).toBe('es')
  })

  it('translatePacketContent throws for an English/empty target (caller treats as skip)', async () => {
    await expect(translatePacketContent({ title: 't', sections: [] }, 'en')).rejects.toThrow()
  })
})
