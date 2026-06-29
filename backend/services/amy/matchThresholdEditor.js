/**
 * matchThresholdEditor.js
 *
 * Surgical, reversible editor for the ONE real crawler knob Amy's loop is
 * allowed to auto-apply: `DEFAULT_MIN_SCORE` in backend/config/matchThresholds.js
 * (the "75% slider" floor). Editing a single, well-isolated constant is the
 * lowest-risk way to make a genuine, persistent change to crawler behavior.
 *
 * Every write is backed up to audit-reports/amy-threshold-backups/ and can be
 * restored, so the change is fully reversible.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const MATCH_THRESHOLDS_PATH = path.resolve(__dirname, '../../config/matchThresholds.js')
const REPO_ROOT = path.resolve(__dirname, '../../../')
const BACKUP_DIR = path.join(REPO_ROOT, 'audit-reports', 'amy-threshold-backups')

const MIN_SCORE_RX = /(export\s+const\s+DEFAULT_MIN_SCORE\s*=\s*)(\d+)/

/** Read the current DEFAULT_MIN_SCORE from the file (null if unreadable). */
export async function readCurrentMinScore(filePath = MATCH_THRESHOLDS_PATH) {
  try {
    const text = await fs.readFile(filePath, 'utf8')
    const m = text.match(MIN_SCORE_RX)
    return m ? Number(m[2]) : null
  } catch {
    return null
  }
}

/**
 * Apply a new DEFAULT_MIN_SCORE. Backs up the file first. Returns a record with
 * the backup path so the change can be reverted.
 *
 * @returns {Promise<{ applied:boolean, from:number|null, to:number, backup_path:string|null, reason?:string }>}
 */
export async function applyMinScore(value, { filePath = MATCH_THRESHOLDS_PATH, now = new Date() } = {}) {
  const to = Math.round(Number(value))
  if (!Number.isFinite(to)) return { applied: false, from: null, to: value, backup_path: null, reason: 'invalid_value' }

  let text
  try {
    text = await fs.readFile(filePath, 'utf8')
  } catch (err) {
    return { applied: false, from: null, to, backup_path: null, reason: `read_failed:${err?.message}` }
  }
  const m = text.match(MIN_SCORE_RX)
  if (!m) return { applied: false, from: null, to, backup_path: null, reason: 'constant_not_found' }
  const from = Number(m[2])
  if (from === to) return { applied: false, from, to, backup_path: null, reason: 'no_change' }

  // Backup before writing.
  let backupPath = null
  try {
    await fs.mkdir(BACKUP_DIR, { recursive: true })
    const stamp = (now instanceof Date ? now : new Date(now)).toISOString().replace(/[:.]/g, '-')
    backupPath = path.join(BACKUP_DIR, `matchThresholds.${stamp}.bak.js`)
    await fs.writeFile(backupPath, text, 'utf8')
  } catch (err) {
    return { applied: false, from, to, backup_path: null, reason: `backup_failed:${err?.message}` }
  }

  const next = text.replace(MIN_SCORE_RX, `$1${to}`)
  try {
    await fs.writeFile(filePath, next, 'utf8')
  } catch (err) {
    return { applied: false, from, to, backup_path: backupPath, reason: `write_failed:${err?.message}` }
  }

  // Confirm the write took (read-back); revert on mismatch.
  const confirmed = await readCurrentMinScore(filePath)
  if (confirmed !== to) {
    await restoreFromBackup(backupPath, filePath).catch(() => {})
    return { applied: false, from, to, backup_path: backupPath, reason: 'verify_failed_reverted' }
  }

  return { applied: true, from, to, backup_path: path.relative(REPO_ROOT, backupPath) }
}

// ── Scoring weights (W_NEED + W_ELIGIBILITY + W_GEO + W_CATEGORY, sum 1.0) ──

export const WEIGHT_KEYS = ['W_NEED', 'W_ELIGIBILITY', 'W_GEO', 'W_CATEGORY']
const weightRx = (key) => new RegExp(`(export\\s+const\\s+${key}\\s*=\\s*)([\\d.]+)`)

/** Read the four scoring weights (null if any unreadable). */
export async function readCurrentWeights(filePath = MATCH_THRESHOLDS_PATH) {
  try {
    const text = await fs.readFile(filePath, 'utf8')
    const out = {}
    for (const key of WEIGHT_KEYS) {
      const m = text.match(weightRx(key))
      if (!m) return null
      out[key] = Number(m[2])
    }
    return out
  } catch {
    return null
  }
}

/** Normalize a weight map to sum exactly 1.0 (rounded to 2dp, remainder on W_NEED). */
export function normalizeWeights(weights) {
  const clamped = {}
  for (const k of WEIGHT_KEYS) clamped[k] = Math.max(0.1, Math.min(0.5, Number(weights[k]) || 0))
  const sum = WEIGHT_KEYS.reduce((s, k) => s + clamped[k], 0)
  const scaled = {}
  for (const k of WEIGHT_KEYS) scaled[k] = Math.round((clamped[k] / sum) * 100) / 100
  // Fix rounding drift so the sum is exactly 1.00.
  const drift = Math.round((1 - WEIGHT_KEYS.reduce((s, k) => s + scaled[k], 0)) * 100) / 100
  scaled.W_NEED = Math.round((scaled.W_NEED + drift) * 100) / 100
  return scaled
}

/**
 * Apply new scoring weights (normalized to sum 1.0). Backs up first; verifies;
 * reverts on mismatch.
 * @returns {{ applied, from, to, backup_path, reason? }}
 */
export async function applyWeights(weights, { filePath = MATCH_THRESHOLDS_PATH, now = new Date() } = {}) {
  const to = normalizeWeights(weights)
  let text
  try {
    text = await fs.readFile(filePath, 'utf8')
  } catch (err) {
    return { applied: false, from: null, to, backup_path: null, reason: `read_failed:${err?.message}` }
  }
  const from = {}
  for (const key of WEIGHT_KEYS) {
    const m = text.match(weightRx(key))
    if (!m) return { applied: false, from: null, to, backup_path: null, reason: `missing:${key}` }
    from[key] = Number(m[2])
  }
  const unchanged = WEIGHT_KEYS.every((k) => from[k] === to[k])
  if (unchanged) return { applied: false, from, to, backup_path: null, reason: 'no_change' }

  let backupPath = null
  try {
    await fs.mkdir(BACKUP_DIR, { recursive: true })
    const stamp = (now instanceof Date ? now : new Date(now)).toISOString().replace(/[:.]/g, '-')
    backupPath = path.join(BACKUP_DIR, `matchThresholds.weights.${stamp}.bak.js`)
    await fs.writeFile(backupPath, text, 'utf8')
  } catch (err) {
    return { applied: false, from, to, backup_path: null, reason: `backup_failed:${err?.message}` }
  }

  let next = text
  for (const key of WEIGHT_KEYS) next = next.replace(weightRx(key), `$1${to[key]}`)
  try {
    await fs.writeFile(filePath, next, 'utf8')
  } catch (err) {
    return { applied: false, from, to, backup_path: backupPath, reason: `write_failed:${err?.message}` }
  }

  const confirmed = await readCurrentWeights(filePath)
  const ok = confirmed && WEIGHT_KEYS.every((k) => confirmed[k] === to[k])
  if (!ok) {
    await restoreFromBackup(backupPath, filePath).catch(() => {})
    return { applied: false, from, to, backup_path: backupPath, reason: 'verify_failed_reverted' }
  }
  return { applied: true, from, to, backup_path: path.relative(REPO_ROOT, backupPath) }
}

/** Restore matchThresholds.js from a backup file. */
export async function restoreFromBackup(backupPath, filePath = MATCH_THRESHOLDS_PATH) {
  const abs = path.isAbsolute(backupPath) ? backupPath : path.join(REPO_ROOT, backupPath)
  const text = await fs.readFile(abs, 'utf8')
  await fs.writeFile(filePath, text, 'utf8')
  return true
}

export default {
  MATCH_THRESHOLDS_PATH,
  readCurrentMinScore,
  applyMinScore,
  readCurrentWeights,
  applyWeights,
  normalizeWeights,
  WEIGHT_KEYS,
  restoreFromBackup,
}
