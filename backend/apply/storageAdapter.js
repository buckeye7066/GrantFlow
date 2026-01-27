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
  const base = resolveBaseDir()
  const appDir = path.join(base, String(applicationId))
  await ensureDir(appDir)

  const safeExt = String(extension || '').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'bin'
  const fileName = `${String(artifactId)}.${safeExt}`
  const fullPath = path.join(appDir, fileName)

  await fs.writeFile(fullPath, buffer)

  return { storage_path: fullPath, file_name: fileName }
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

