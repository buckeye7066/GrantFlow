/**
 * pruneDiskArtifacts.js — bound the growth of on-disk artifacts so the Railway
 * persistent volume (/data) can't silently fill and crash prod again.
 *
 * Two classes of on-disk writer accumulate without bound:
 *
 *   1. TEMP / regenerable artifacts — Hamilton confirmation screenshots and the
 *      DOCX/HTML/PDF packet copies written under HAMILTON_PACKET_STORAGE_DIR.
 *      Packet BYTES are also stored in Postgres (documents.file_bytes), so the
 *      disk copies are throwaway; screenshots are diagnostic only. These are
 *      pruned by age with no DB check.
 *
 *   2. ORPHANED uploads — files left in UPLOADS_DIR that no `documents` row
 *      references. These come from failed ingests and, historically, from
 *      DELETE /api/documents/:id removing the row but not the file. We only
 *      delete a file when NO documents row references its basename AND it is
 *      older than a generous grace window, so real user data is never touched.
 *
 * Every deletion is logged. All steps are best-effort — a prune failure must
 * never abort the nightly sweep.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLogger } from '../../utils/logger.js'
import { resolveUploadsDir } from '../../utils/uploadsDir.js'

const log = createLogger('pruneDiskArtifacts')

const HOUR_MS = 60 * 60 * 1000

function hoursMs(hours, fallbackHours) {
  const n = Number(hours)
  return (Number.isFinite(n) && n >= 0 ? n : fallbackHours) * HOUR_MS
}

/**
 * Delete files in a flat directory older than maxAgeMs. Best-effort; returns a
 * summary. Skips directories (only prunes top-level files) and never throws.
 */
export async function pruneAgedFiles(dir, { maxAgeMs, label = 'temp', now = Date.now(), match = null } = {}) {
  const summary = { dir, deleted: 0, bytes: 0, scanned: 0, skipped: 0 }
  if (!dir) return summary
  let entries
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    // Directory doesn't exist yet — nothing to prune.
    return summary
  }
  for (const ent of entries) {
    if (!ent.isFile()) continue
    if (typeof match === 'function' && !match(ent.name)) continue
    summary.scanned += 1
    const full = path.join(dir, ent.name)
    try {
      const st = await fs.promises.stat(full)
      const age = now - st.mtimeMs
      if (age < maxAgeMs) {
        summary.skipped += 1
        continue
      }
      const size = st.size
      await fs.promises.unlink(full)
      summary.deleted += 1
      summary.bytes += size
      log.info('pruned aged artifact', { label, file: full, age_hours: Math.round(age / HOUR_MS) })
    } catch (err) {
      log.debug('prune skip (stat/unlink failed)', { label, file: full, error: err?.message })
    }
  }
  if (summary.deleted > 0) {
    log.info('aged-artifact prune complete', { label, dir, deleted: summary.deleted, freed_mib: Math.round((summary.bytes / (1024 * 1024)) * 10) / 10 })
  }
  return summary
}

/**
 * Delete files in UPLOADS_DIR that no `documents` row references and that are
 * older than the grace window. Conservative: a file is an orphan ONLY when its
 * basename appears in no documents.file_path / file_url / file_uri value.
 */
export async function pruneOrphanUploads(db, { uploadsDir, maxAgeMs, now = Date.now() } = {}) {
  const summary = { dir: uploadsDir || null, deleted: 0, bytes: 0, scanned: 0, kept: 0, referenced: 0 }
  if (!db || !uploadsDir) return summary

  let entries
  try {
    entries = await fs.promises.readdir(uploadsDir, { withFileTypes: true })
  } catch {
    return summary
  }
  if (entries.length === 0) return summary

  // Build the set of referenced basenames from the documents table in one pass.
  const referenced = new Set()
  try {
    const rows = await db.prepare('SELECT file_path, file_url FROM documents').all()
    for (const r of rows || []) {
      for (const val of [r?.file_path, r?.file_url]) {
        const s = String(val || '').trim()
        if (!s) continue
        const base = s.split(/[\\/]/).pop()
        if (base) referenced.add(base)
      }
    }
  } catch (err) {
    // If we can't read references, do NOT prune — refuse to guess.
    log.warn('orphan-upload prune aborted (could not read document references)', { error: err?.message })
    return summary
  }

  for (const ent of entries) {
    if (!ent.isFile()) continue
    const name = ent.name
    // Never touch dotfiles / write-test markers / anything referenced.
    if (name.startsWith('.') || name.startsWith('.write-test-')) continue
    summary.scanned += 1
    if (referenced.has(name)) {
      summary.referenced += 1
      continue
    }
    const full = path.join(uploadsDir, name)
    try {
      const st = await fs.promises.stat(full)
      const age = now - st.mtimeMs
      if (age < maxAgeMs) {
        summary.kept += 1
        continue
      }
      const size = st.size
      await fs.promises.unlink(full)
      summary.deleted += 1
      summary.bytes += size
      log.info('pruned orphan upload (no documents row references it)', { file: full, age_hours: Math.round(age / HOUR_MS) })
    } catch (err) {
      log.debug('orphan prune skip (stat/unlink failed)', { file: full, error: err?.message })
    }
  }
  if (summary.deleted > 0) {
    log.info('orphan-upload prune complete', { dir: uploadsDir, deleted: summary.deleted, freed_mib: Math.round((summary.bytes / (1024 * 1024)) * 10) / 10, referenced: summary.referenced })
  }
  return summary
}

/**
 * Orchestrate every disk-artifact prune. Best-effort; each step is isolated so
 * one failure never blocks the others. Returns a structured summary.
 */
export async function pruneAllDiskArtifacts(db, { now = Date.now() } = {}) {
  const result = { at: new Date(now).toISOString() }

  // 1. Hamilton confirmation screenshots (diagnostic, regenerable).
  const screenshotsDir = String(process.env.HAMILTON_SCREENSHOTS_DIR || '').trim()
    || path.join(os.tmpdir(), 'hamilton-autopilot-screens')
  try {
    result.screenshots = await pruneAgedFiles(screenshotsDir, {
      maxAgeMs: hoursMs(process.env.HAMILTON_SCREENSHOT_RETENTION_HOURS, 72),
      label: 'hamilton-screenshots',
      now,
    })
  } catch (err) {
    log.warn('screenshot prune failed (non-fatal)', { error: err?.message })
  }

  // 2. Hamilton packet DOCX/HTML/PDF copies (bytes also live in Postgres).
  const packetsDir = String(process.env.HAMILTON_PACKET_STORAGE_DIR || '').trim()
    || path.join(os.tmpdir(), 'grantflow-hamilton-packets')
  try {
    result.packets = await pruneAgedFiles(packetsDir, {
      maxAgeMs: hoursMs(process.env.HAMILTON_PACKET_RETENTION_HOURS, 168),
      label: 'hamilton-packets',
      now,
    })
  } catch (err) {
    log.warn('packet prune failed (non-fatal)', { error: err?.message })
  }

  // 3. Orphaned uploads on the persistent volume (opt-outable; ON by default).
  if (String(process.env.UPLOADS_ORPHAN_PRUNE_ENABLED ?? 'true').toLowerCase() !== 'false') {
    try {
      const { uploadsDir } = resolveUploadsDir()
      result.orphan_uploads = await pruneOrphanUploads(db, {
        uploadsDir,
        maxAgeMs: hoursMs(process.env.UPLOADS_ORPHAN_GRACE_HOURS, 168),
        now,
      })
    } catch (err) {
      log.warn('orphan-upload prune failed (non-fatal)', { error: err?.message })
    }
  }

  return result
}
