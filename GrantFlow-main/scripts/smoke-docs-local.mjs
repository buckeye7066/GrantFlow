#!/usr/bin/env node
/**
 * Local end-to-end smoke for document ingestion (admin token auth).
 *
 * Requires backend running locally.
 *
 * Env:
 *  - SMOKE_API_BASE (default: http://127.0.0.1:18194)
 *  - X_ADMIN_TOKEN  (default: dev-admin-token)
 */

import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'

const base = String(process.env.SMOKE_API_BASE || 'http://127.0.0.1:18194').replace(/\/+$/, '')
const adminToken = String(process.env.X_ADMIN_TOKEN || 'dev-admin-token')
const execFileAsync = promisify(execFile)

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms))
}

async function waitForServer() {
  const url = `${base}/healthz`
  for (let i = 0; i < 30; i += 1) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {
      // ignore
    }
    await sleep(250)
  }
  throw new Error(`Backend not reachable at ${url}`)
}

async function apiFetch(path, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'x-admin-token': adminToken,
      ...headers,
    },
    body,
  })
  const contentType = res.headers.get('content-type') || ''
  const parsed = contentType.includes('application/json') ? await res.json() : await res.text()
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`)
  }
  return parsed
}

async function createProfile() {
  return await apiFetch('/api/profiles', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ display_name: 'Smoke Doc Profile', primary_type: 'individual' }),
  })
}

async function buildPdfBytes() {
  const pdfDoc = await PDFDocument.create()
  const page = pdfDoc.addPage([500, 240])
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica)
  page.drawText('Smoke PDF Profile Intake', { x: 40, y: 190, size: 18, font, color: rgb(0, 0, 0) })
  page.drawText('Name: Smoke User', { x: 40, y: 150, size: 14, font })
  page.drawText('Email: smoke.user@example.com', { x: 40, y: 130, size: 14, font })
  page.drawText('Phone: 555-555-1212', { x: 40, y: 110, size: 14, font })
  const bytes = await pdfDoc.save()
  return Buffer.from(bytes)
}

async function pickAnyTempImagePath() {
  const dir = join(process.cwd(), 'backend', 'temp_images')
  let files = []
  try {
    files = await fsp.readdir(dir)
  } catch {
    return null
  }
  const candidate = files.find((f) => /\.(jpe?g|png|webp|gif|bmp|tiff?)$/i.test(f))
  return candidate ? join(dir, candidate) : null
}

async function ingestFormData({ profileId, fileName, mimeType, bytes, handwriting }) {
  // NOTE: Node's built-in FormData/file upload path can subtly corrupt binary bytes on Windows.
  // Use curl.exe to ensure a faithful multipart upload for this smoke test.
  const safeBytes = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  const tmpPath = join(process.cwd(), 'backend', 'uploads', `smoke-${Date.now()}-${fileName}`)
  await fsp.writeFile(tmpPath, safeBytes)

  try {
    const args = [
      '-sS',
      '-X',
      'POST',
      `${base}/api/documents/ingest`,
      '-H',
      `x-admin-token: ${adminToken}`,
      '-F',
      `profile_id=${profileId}`,
      '-F',
      `name=${fileName}`,
      '-F',
      `type=source_material`,
      '-F',
      `ocr=true`,
      '-F',
      `handwriting=${handwriting ? 'true' : 'false'}`,
      '-F',
      `ocr_language=eng`,
      // For this smoke we skip AI parsing (no external key needed), but we DO verify extracted_text.
      '-F',
      `skip_parsing=true`,
      '-F',
      `document=@${tmpPath};type=${mimeType}`,
    ]

    const { stdout } = await execFileAsync('curl.exe', args, { windowsHide: true, maxBuffer: 5 * 1024 * 1024 })
    return JSON.parse(String(stdout || '{}'))
  } finally {
    await fsp.rm(tmpPath, { force: true })
  }
}

async function run() {
  await waitForServer()

  const profile = await createProfile()
  console.log('[smoke-docs-local] profile_id', profile.id)

  const pdfBytes = await buildPdfBytes()
  const pdf = await ingestFormData({
    profileId: profile.id,
    fileName: 'smoke.pdf',
    mimeType: 'application/pdf',
    bytes: pdfBytes,
    handwriting: false,
  })
  console.log('[smoke-docs-local] ingested_pdf', pdf.id)

  const imgPath = await pickAnyTempImagePath()
  if (imgPath) {
    const imgBytes = await fsp.readFile(imgPath)
    const imgName = imgPath.split(/[/\\]/).pop() || 'smoke-image.jpg'
    const image = await ingestFormData({
      profileId: profile.id,
      fileName: imgName,
      mimeType: 'image/jpeg',
      bytes: imgBytes,
      handwriting: true,
    })
    console.log('[smoke-docs-local] ingested_image', image.id)
  } else {
    console.log('[smoke-docs-local] no temp image found under backend/temp_images (skipping image OCR smoke)')
  }

  const docs = await apiFetch(`/api/documents?profile_id=${encodeURIComponent(profile.id)}`)
  console.log('[smoke-docs-local] docs_for_profile', docs.length)
  for (const doc of docs.slice(0, 3)) {
    console.log('[smoke-docs-local] doc', {
      id: doc.id,
      name: doc.name,
      mime_type: doc.mime_type,
      processing_status: doc.processing_status,
      has_extracted_text: Boolean(doc.extracted_text && String(doc.extracted_text).trim()),
      profile_id: doc.profile_id,
    })
  }

  const adminAllDocs = await apiFetch('/api/documents')
  const inAdminList = adminAllDocs.some((d) => d.profile_id === profile.id)
  console.log('[smoke-docs-local] admin_list_includes_profile_docs', inAdminList)

  console.log('[smoke-docs-local] OK')
}

run().catch((err) => {
  console.error('[smoke-docs-local] FAILED', err)
  process.exitCode = 1
})

