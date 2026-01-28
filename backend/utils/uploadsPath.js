import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'

function normalizeFsPath(p) {
  if (!p) return null
  try {
    return path.resolve(String(p))
  } catch {
    return String(p)
  }
}

/**
 * Resolve canonical uploads directories.
 *
 * - uploadsDir: primary directory used for ALL writes/serving
 * - legacyUploadsDir: older repo-root `/uploads` used by some past deployments
 */
export function resolveUploadsDir({ baseDir } = {}) {
  const safeBase = baseDir ? normalizeFsPath(baseDir) : process.cwd()

  const uploadsDir = process.env.UPLOADS_DIR
    ? normalizeFsPath(process.env.UPLOADS_DIR)
    : normalizeFsPath(path.join(safeBase, 'uploads'))

  // Backward-compat: some older builds stored uploads at repo-root `/uploads`
  const legacyUploadsDir = normalizeFsPath(path.join(safeBase, '..', 'uploads'))

  return { uploadsDir, legacyUploadsDir }
}

export function isLikelyPersistentPath(dir) {
  const d = String(dir || '').trim()
  if (!d) return false

  const prefixes = String(process.env.UPLOADS_PERSIST_PREFIXES || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)

  const defaults = [
    '/data', // Railway volumes commonly mounted here
    '/mnt',
    '/var/lib',
    '/srv',
    '/opt',
  ]

  const list = (prefixes.length ? prefixes : defaults).map((p) => p.replace(/\\/g, '/'))
  const normalized = d.replace(/\\/g, '/')

  // Windows dev paths: treat as "likely persistent" if absolute and not under temp.
  if (process.platform === 'win32') {
    const lower = normalized.toLowerCase()
    if (lower.includes('/temp') || lower.includes('/tmp')) return false
    return /^[a-z]:\//i.test(lower)
  }

  return list.some((p) => normalized === p || normalized.startsWith(p.endsWith('/') ? p : `${p}/`))
}

export async function ensureUploadsDirWritable(dir) {
  const target = String(dir || '').trim()
  if (!target) {
    return { ok: false, error: 'UPLOADS_DIR is empty' }
  }

  try {
    await fs.promises.mkdir(target, { recursive: true })

    // Basic rw checks
    await fs.promises.access(target, fs.constants.R_OK | fs.constants.W_OK)

    // Real write test (create + delete) to catch read-only mounts
    const marker = `.write-test-${Date.now()}-${crypto.randomUUID?.() || crypto.randomBytes(8).toString('hex')}`
    const testPath = path.join(target, marker)
    await fs.promises.writeFile(testPath, `ok ${new Date().toISOString()} ${os.hostname()}\n`, { encoding: 'utf8' })
    await fs.promises.unlink(testPath)

    return { ok: true }
  } catch (error) {
    return { ok: false, error: error?.message || String(error) }
  }
}

