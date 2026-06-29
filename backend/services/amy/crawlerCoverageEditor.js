/**
 * crawlerCoverageEditor.js
 *
 * Reads/writes the Amy-managed additive coverage overrides. Persists the
 * override literal in backend/config/crawlerCoverageOverrides.js (with a backup)
 * AND updates the live in-memory mirror so the change takes effect for the very
 * next crawl in the same process — enabling empirical re-crawl validation.
 *
 * Additive-only by construction (the merge function only adds categories), and
 * fully reversible via the backup or by restoring the previous override map.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getCoverageOverrides, setCoverageOverrides } from '../../crawler-os/coverageOverrides.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const COVERAGE_FILE = path.resolve(__dirname, '../../crawler-os/coverageOverrides.js')
const REPO_ROOT = path.resolve(__dirname, '../../../')
const BACKUP_DIR = path.join(REPO_ROOT, 'audit-reports', 'amy-coverage-backups')

const BLOCK_RX = /(\/\/ AMY_COVERAGE_OVERRIDES_BEGIN\nexport const COVERAGE_OVERRIDES = )([\s\S]*?)(\n\/\/ AMY_COVERAGE_OVERRIDES_END)/
const KV_KEY = 'crawler_coverage_overrides'

/** Current live overrides (snapshot copy). */
export function readLiveOverrides() {
  return JSON.parse(JSON.stringify(getCoverageOverrides() || {}))
}

async function ensureKv(db) {
  try {
    await db.prepare('CREATE TABLE IF NOT EXISTS system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)').run()
  } catch {
    // table may already exist with a richer shape — fine
  }
}

/** Persist the live coverage overrides to system_kv so they survive restarts. */
export async function persistCoverageOverrides(db) {
  if (!db) return false
  try {
    await ensureKv(db)
    const value = JSON.stringify(getCoverageOverrides() || {})
    const now = new Date().toISOString()
    const res = await db.prepare('UPDATE system_kv SET value = ?, updated_at = ? WHERE key = ?').run(value, now, KV_KEY)
    if (!Number(res?.changes ?? res?.rowCount ?? 0)) {
      await db.prepare('INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)').run(KV_KEY, value, now)
    }
    return true
  } catch {
    return false
  }
}

/** Load persisted coverage overrides into the live store on boot. */
export async function hydrateCoverageOverrides(db) {
  if (!db) return null
  try {
    await ensureKv(db)
    const row = await db.prepare('SELECT value FROM system_kv WHERE key = ?').get(KV_KEY)
    if (!row?.value) return null
    const parsed = JSON.parse(row.value)
    setCoverageOverrides(parsed)
    return parsed
  } catch {
    return null
  }
}

/**
 * Persist + live-apply a new overrides map. Backs up the file first.
 * @returns {{ applied, from, to, backup_path, reason? }}
 */
export async function applyCoverageOverrides(next, { filePath = COVERAGE_FILE, now = new Date(), db = null } = {}) {
  const from = readLiveOverrides()
  const to = next && typeof next === 'object' ? next : {}

  let text
  try {
    text = await fs.readFile(filePath, 'utf8')
  } catch (err) {
    return { applied: false, from, to, backup_path: null, reason: `read_failed:${err?.message}` }
  }
  if (!BLOCK_RX.test(text)) {
    return { applied: false, from, to, backup_path: null, reason: 'marker_block_not_found' }
  }

  let backupPath = null
  try {
    await fs.mkdir(BACKUP_DIR, { recursive: true })
    const stamp = (now instanceof Date ? now : new Date(now)).toISOString().replace(/[:.]/g, '-')
    backupPath = path.join(BACKUP_DIR, `crawlerCoverageOverrides.${stamp}.bak.js`)
    await fs.writeFile(backupPath, text, 'utf8')
  } catch (err) {
    return { applied: false, from, to, backup_path: null, reason: `backup_failed:${err?.message}` }
  }

  const json = JSON.stringify(to, null, 2)
  const nextText = text.replace(BLOCK_RX, `$1${json}$3`)
  try {
    await fs.writeFile(filePath, nextText, 'utf8')
  } catch (err) {
    return { applied: false, from, to, backup_path: backupPath, reason: `write_failed:${err?.message}` }
  }

  // Live-apply so the next crawl in THIS process sees it.
  setCoverageOverrides(to)
  // Persist to the DB too so the improvement survives restarts/redeploys (the
  // file edit is ephemeral on a container filesystem).
  if (db) await persistCoverageOverrides(db)
  return { applied: true, from, to, backup_path: path.relative(REPO_ROOT, backupPath) }
}

/** Revert to a previous overrides map (live) and restore the file from backup. */
export async function revertCoverageOverrides(previousMap, backupPath, { filePath = COVERAGE_FILE, db = null } = {}) {
  setCoverageOverrides(previousMap && typeof previousMap === 'object' ? previousMap : {})
  if (db) await persistCoverageOverrides(db)
  if (backupPath) {
    const abs = path.isAbsolute(backupPath) ? backupPath : path.join(REPO_ROOT, backupPath)
    try {
      const text = await fs.readFile(abs, 'utf8')
      await fs.writeFile(filePath, text, 'utf8')
    } catch {
      // Live revert already happened; file restore is best-effort.
    }
  }
  return true
}

export default { COVERAGE_FILE, readLiveOverrides, applyCoverageOverrides, revertCoverageOverrides }
