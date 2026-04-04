import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

function resolveBaseDir() {
  const configured = String(process.env.APPLY_STORAGE_DIR || '').trim()
  if (configured) return path.resolve(configured)
  // Default: backend/storage/applications (local dev)
  return path.resolve(__dirname, '..', 'storage', 'applications')
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true })
}

export function getApplicationsStorageBaseDir() {
  return resolveBaseDir()
}

export async function writeApplicationArtifact({ applicationId, artifactId, extension, buffer }) {
  if (!applicationId) throw Object.assign(new Error('applicationId is required'), { status: 400 })
  if (!artifactId) throw Object.assign(new Error('artifactId is required'), { status: 400 })
  if (!buffer || !(Buffer.isBuffer(buffer) || buffer instanceof Uint8Array)) {
    throw Object.assign(new Error('buffer must be a Buffer or Uint8Array'), { status: 400 })
  }
  const base = resolveBaseDir()
  const resolvedBase = path.resolve(base)
  const appDir = path.join(base, String(applicationId))
  const resolvedAppDir = path.resolve(appDir)
  if (!resolvedAppDir.startsWith(resolvedBase + path.sep) && resolvedAppDir !== resolvedBase) {
    const err = new Error('Invalid applicationId: path traversal detected')
    err.status = 400
    throw err
  }
  await ensureDir(appDir)

  const safeExt = String(extension || '').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'bin'
  const safeArtifactId = String(artifactId).replace(/[^a-zA-Z0-9_-]/g, '_')
  const fileName = `${safeArtifactId}.${safeExt}`
  const fullPath = path.join(appDir, fileName)

  // Guard: ensure resolved path stays inside appDir (defence-in-depth)
  const resolvedFull = path.resolve(fullPath)
  const resolvedDir = path.resolve(appDir)
  if (!resolvedFull.startsWith(resolvedDir + path.sep) && resolvedFull !== resolvedDir) {
    const err = new Error('Invalid artifact path: traversal detected')
    err.status = 400
    throw err
  }

  await fs.writeFile(resolvedFull, buffer)

  return { storage_path: resolvedFull, file_name: fileName }
}

export function assertArtifactPathIsSafe({ applicationId, storagePath }) {
  const base = resolveBaseDir()
  const expectedDir = path.join(base, String(applicationId))
  const resolved = path.resolve(storagePath)
  const expectedResolved = path.resolve(expectedDir)

  if (!resolved.startsWith(expectedResolved + path.sep) && resolved !== expectedResolved) {
    const err = new Error('Invalid artifact path')
    err.status = 400
    throw err
  }

  return resolved
}

