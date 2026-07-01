/**
 * Tests for the disk-volume hygiene added to bound growth of on-disk artifacts
 * so the Railway persistent volume can't silently fill and crash prod again.
 *
 * Covers:
 *   - diskUsage.getDiskUsage / checkAndLogDiskUsage return a sane usage object.
 *   - pruneAgedFiles deletes files older than the cutoff and keeps fresh ones.
 *   - pruneOrphanUploads deletes ONLY files no documents row references (and
 *     only once past the grace window), never touching referenced user data.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { getDiskUsage, checkAndLogDiskUsage } from '../services/maintenance/diskUsage.js'
import { pruneAgedFiles, pruneOrphanUploads } from '../services/maintenance/pruneDiskArtifacts.js'

const DAY_MS = 24 * 60 * 60 * 1000

function mkTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function writeFileAged(dir, name, ageMs) {
  const full = path.join(dir, name)
  fs.writeFileSync(full, 'x'.repeat(1024))
  if (ageMs > 0) {
    const t = (Date.now() - ageMs) / 1000
    fs.utimesSync(full, t, t)
  }
  return full
}

describe('diskUsage', () => {
  it('returns a usage object with a numeric usedPct for a real path', async () => {
    const usage = await getDiskUsage(os.tmpdir())
    // statfs is available on Node 20+, but guard for exotic platforms.
    if (usage === null) return
    expect(usage.totalBytes).toBeGreaterThan(0)
    expect(usage.usedPct).toBeGreaterThanOrEqual(0)
    expect(usage.usedPct).toBeLessThanOrEqual(100)
  })

  it('checkAndLogDiskUsage never throws and returns usage or null', async () => {
    const usage = await checkAndLogDiskUsage({ label: 'test', targetPath: os.tmpdir(), threshold: 80 })
    expect(usage === null || typeof usage.usedPct === 'number').toBe(true)
  })
})

describe('pruneAgedFiles', () => {
  let dir
  beforeEach(() => { dir = mkTmpDir('grantflow-prune-aged-') })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('deletes files older than maxAgeMs and keeps fresh files', async () => {
    writeFileAged(dir, 'old.png', 5 * DAY_MS)
    writeFileAged(dir, 'fresh.png', 0)

    const res = await pruneAgedFiles(dir, { maxAgeMs: 3 * DAY_MS, label: 'test' })

    expect(res.deleted).toBe(1)
    expect(fs.existsSync(path.join(dir, 'old.png'))).toBe(false)
    expect(fs.existsSync(path.join(dir, 'fresh.png'))).toBe(true)
  })

  it('is a no-op when the directory does not exist', async () => {
    const res = await pruneAgedFiles(path.join(dir, 'does-not-exist'), { maxAgeMs: 0, label: 'test' })
    expect(res.deleted).toBe(0)
  })
})

describe('pruneOrphanUploads', () => {
  let db
  let uploadsDir

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE documents (
        id TEXT PRIMARY KEY,
        file_path TEXT,
        file_url TEXT
      );
    `)
    uploadsDir = mkTmpDir('grantflow-prune-orphan-')
  })
  afterEach(() => {
    fs.rmSync(uploadsDir, { recursive: true, force: true })
    db.close()
  })

  it('deletes aged orphans but keeps referenced files and fresh orphans', async () => {
    // referenced.pdf is referenced by a documents row (via file_url).
    const referenced = writeFileAged(uploadsDir, 'referenced.pdf', 10 * DAY_MS)
    // referenced-by-path.docx is referenced via file_path (absolute).
    const referencedByPath = writeFileAged(uploadsDir, 'referenced-by-path.docx', 10 * DAY_MS)
    // aged orphan — no row references it, old enough to prune.
    const agedOrphan = writeFileAged(uploadsDir, 'orphan-old.bin', 10 * DAY_MS)
    // fresh orphan — no row references it but inside the grace window.
    const freshOrphan = writeFileAged(uploadsDir, 'orphan-fresh.bin', 1 * DAY_MS)

    db.prepare('INSERT INTO documents (id, file_path, file_url) VALUES (?, ?, ?)')
      .run('d1', null, '/uploads/referenced.pdf')
    db.prepare('INSERT INTO documents (id, file_path, file_url) VALUES (?, ?, ?)')
      .run('d2', referencedByPath, null)

    const res = await pruneOrphanUploads(db, { uploadsDir, maxAgeMs: 7 * DAY_MS })

    expect(res.deleted).toBe(1)
    expect(fs.existsSync(agedOrphan)).toBe(false)
    expect(fs.existsSync(freshOrphan)).toBe(true)
    expect(fs.existsSync(referenced)).toBe(true)
    expect(fs.existsSync(referencedByPath)).toBe(true)
  })

  it('does not prune when document references cannot be read (fail-safe)', async () => {
    const orphan = writeFileAged(uploadsDir, 'orphan.bin', 30 * DAY_MS)
    const brokenDb = {
      prepare() {
        return { all() { throw new Error('boom') } }
      },
    }
    const res = await pruneOrphanUploads(brokenDb, { uploadsDir, maxAgeMs: 0 })
    expect(res.deleted).toBe(0)
    expect(fs.existsSync(orphan)).toBe(true)
  })
})
