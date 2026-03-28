#!/usr/bin/env node
/**
 * Local end-to-end smoke for document ingestion (admin token auth).
 *
 * Requires backend running locally.
 *
 * Env:
 *  - SMOKE_API_BASE (default: http://127.0.0.1:18194)
 *  - X_ADMIN_TOKEN  (required; must match backend ADMIN_TOKEN)
 */

import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const base = String(process.env.SMOKE_API_BASE || 'http://127.0.0.1:18194').replace(/\/+$/, '')
const adminToken = String(process.env.X_ADMIN_TOKEN || process.env.ADMIN_TOKEN || '').trim()
if (!adminToken) {
  console.error('[smoke-docs-local] Missing X_ADMIN_TOKEN (or ADMIN_TOKEN). Refusing to run without explicit admin auth.')
  process.exit(1)
}
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
  // Hand-crafted minimal PDF (no pdf-lib dependency required)
  const textLines = [
    'Smoke PDF Profile Intake',
    'Name: Smoke User',
    'Email: smoke.user@example.com',
    'Phone: 555-555-1212',
  ]
  const stream = textLines
    .map((line, i) => `BT /F1 ${i === 0 ? 18 : 14} Tf 40 ${190 - i * 20} Td (${line}) Tj ET`)
    .join('\n')
  const parts = [
    '%PDF-1.4\n',
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 500 240]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n',
    '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n',
    `4 0 obj<</Length ${stream.length}>>\nstream\n${stream}\nendstream\nendobj\n`,
  ]
  const body = parts.join('')
  const xrefOffset = body.length
  const offsets = ['1 0 obj', '2 0 obj', '3 0 obj', '4 0 obj', '5 0 obj'].map(
    (marker) => String(body.indexOf(marker)).padStart(10, '0'),
  )
  const xref = [
    'xref',
    '0 6',
    '0000000000 65535 f ',
    ...offsets.map((o) => `${o} 00000 n `),
    'trailer<</Size 6/Root 1 0 R>>',
    'startxref',
    String(xrefOffset),
    '%%EOF',
  ].join('\n')
  return Buffer.from(body + xref)
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

