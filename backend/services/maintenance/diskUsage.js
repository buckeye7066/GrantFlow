/**
 * diskUsage.js — lightweight disk-usage observability for the Railway volume.
 *
 * The production persistent volume (mounted at RAILWAY_VOLUME_MOUNT_PATH, e.g.
 * /data, where UPLOADS_DIR lives) once filled to 100% and crashed prod: writes
 * failed → the process died → it restarted → filled again. Resizing the volume
 * only DELAYS a recurrence. This module makes the next fill VISIBLE before it
 * crashes by logging a WARN when usage crosses a threshold, on boot and on the
 * nightly sweep.
 *
 * Zero-dependency: uses fs.statfs (Node 18.15+, present on our Node 20+ runtime).
 * Best-effort everywhere — an observability probe must never throw into a boot
 * path or a maintenance sweep.
 */

import fs from 'node:fs'
import path from 'node:path'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('diskUsage')

/**
 * Resolve the path that best represents the persistent volume we care about.
 * Preference: explicit RAILWAY_VOLUME_MOUNT_PATH → the directory UPLOADS_DIR
 * lives under → UPLOADS_DIR itself → process.cwd() (dev fallback).
 */
export function resolveVolumePath() {
  const mount = String(process.env.RAILWAY_VOLUME_MOUNT_PATH || '').trim()
  if (mount) return path.resolve(mount)
  const uploads = String(process.env.UPLOADS_DIR || '').trim()
  if (uploads) {
    // UPLOADS_DIR is typically <mount>/uploads; statfs on the mount and on any
    // path under it report the same filesystem, so either works.
    return path.resolve(uploads)
  }
  return process.cwd()
}

export function getDiskUsageWarnThreshold() {
  const raw = Number(process.env.DISK_USAGE_WARN_PCT)
  if (Number.isFinite(raw) && raw > 0 && raw <= 100) return raw
  return 80
}

/**
 * Return disk usage for the filesystem containing `targetPath`, or null when
 * unavailable (older Node, unsupported platform, path missing).
 *
 * usedPct follows `df`'s convention: used / (used + available) — i.e. how full
 * the space actually usable by this process is, ignoring root-reserved blocks.
 */
export async function getDiskUsage(targetPath = resolveVolumePath()) {
  const statfs = fs.promises?.statfs
  if (typeof statfs !== 'function') return null
  try {
    const s = await statfs(targetPath)
    const bsize = Number(s.bsize) || 0
    const blocks = Number(s.blocks) || 0
    const bfree = Number(s.bfree) || 0
    const bavail = Number(s.bavail) || 0
    if (!bsize || !blocks) return null
    const totalBytes = blocks * bsize
    const freeBytes = bfree * bsize
    const availBytes = bavail * bsize
    const usedBytes = totalBytes - freeBytes
    const capacityBytes = usedBytes + availBytes
    const usedPct = capacityBytes > 0 ? (usedBytes / capacityBytes) * 100 : 0
    return {
      path: targetPath,
      totalBytes,
      freeBytes,
      availBytes,
      usedBytes,
      usedPct: Math.round(usedPct * 10) / 10,
    }
  } catch (err) {
    // ENOSYS on some platforms, ENOENT if the mount isn't there yet.
    log.debug('statfs unavailable', { path: targetPath, error: err?.message })
    return null
  }
}

function fmtGiB(bytes) {
  if (!Number.isFinite(bytes)) return null
  return Math.round((bytes / (1024 ** 3)) * 100) / 100
}

/**
 * Probe volume usage and log a WARN when it crosses the threshold (default 80%).
 * Returns the usage object (or null). Never throws.
 */
export async function checkAndLogDiskUsage({ label = 'boot', targetPath = resolveVolumePath(), threshold = getDiskUsageWarnThreshold() } = {}) {
  try {
    const usage = await getDiskUsage(targetPath)
    if (!usage) {
      log.debug('disk usage unavailable', { label, path: targetPath })
      return null
    }
    const ctx = {
      label,
      path: usage.path,
      used_pct: usage.usedPct,
      used_gib: fmtGiB(usage.usedBytes),
      avail_gib: fmtGiB(usage.availBytes),
      total_gib: fmtGiB(usage.totalBytes),
      threshold_pct: threshold,
    }
    if (usage.usedPct >= threshold) {
      log.warn(`volume ${usage.usedPct}% full (>= ${threshold}% threshold) — free disk before it fills`, ctx)
    } else {
      log.info('volume disk usage', ctx)
    }
    return usage
  } catch (err) {
    log.debug('disk usage check failed (non-fatal)', { label, error: err?.message })
    return null
  }
}
