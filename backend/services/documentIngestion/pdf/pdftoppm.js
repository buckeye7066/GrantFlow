import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

function candidates() {
  // PATH-first, then common Windows Poppler installs.
  if (process.platform === 'win32') {
    return [
      'pdftoppm.exe',
      'pdftoppm',
      'C:\\Program Files\\poppler-24.08.0\\Library\\bin\\pdftoppm.exe',
      'C:\\ProgramData\\chocolatey\\bin\\pdftoppm.exe',
    ]
  }
  return ['pdftoppm']
}

async function exists(filePath) {
  try {
    await fsp.access(filePath)
    return true
  } catch {
    return false
  }
}

async function resolveBinary() {
  for (const bin of candidates()) {
    if (bin.includes('\\')) {
      if (await exists(bin)) return bin
      continue
    }
    // PATH resolution happens in execFile; try it directly.
    try {
      await execFileAsync(bin, ['-h'], { timeout: 2_000, maxBuffer: 1024 * 1024 })
      return bin
    } catch (error) {
      // ENOENT => try next; other errors still indicate binary exists
      if (error?.code === 'ENOENT') continue
      return bin
    }
  }
  return null
}

/**
 * Convert PDF pages to PNG images using Poppler's `pdftoppm`.
 * Returns absolute image paths sorted in page order.
 */
export async function pdfToPngPages({
  pdfPath,
  maxPages = null,
  dpi = 150,
} = {}) {
  if (!pdfPath || typeof pdfPath !== 'string') {
    throw new Error('pdfPath must be a non-empty string')
  }
  const bin = await resolveBinary()
  if (!bin) {
    throw new Error(
      'OCR for scanned PDFs requires Poppler `pdftoppm` (not found). ' +
        'Install Poppler and ensure `pdftoppm` is on PATH, or set OCR_PROVIDER=aws_textract.',
    )
  }

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'grantflow-pdfpages-'))
  const prefix = path.join(dir, 'page')

  const args = ['-png', '-r', String(dpi)]
  if (typeof maxPages === 'number' && Number.isFinite(maxPages) && maxPages > 0) {
    args.push('-l', String(Math.floor(maxPages)))
  }
  args.push(pdfPath, prefix)

  try {
    await execFileAsync(bin, args, { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 })
    const files = (await fsp.readdir(dir))
      .filter((f) => f.toLowerCase().endsWith('.png'))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map((f) => path.join(dir, f))
    if (files.length === 0) {
      // Cleanup on failure before throwing
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
      throw new Error('pdftoppm produced no images')
    }
    return { dir, files }
  } catch (error) {
    // Cleanup on failure.
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => { /* temp cleanup */ })
    throw error
  }
}

export async function cleanupPdfPages(tmpDir) {
  if (!tmpDir) return
  await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* temp cleanup */ })
}

