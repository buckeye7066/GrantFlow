#!/usr/bin/env node
/**
 * Upload persistence verification (local):
 * - Upload profile avatar and a document
 * - Persist the resulting download URLs to docs/verification/uploads-persistence.json
 * - Verify both URLs are still accessible (run again after restarting backend to prove persistence)
 *
 * Env:
 * - VERIFY_BACKEND_BASE_URL (default http://127.0.0.1:19181)
 * - VERIFY_ADMIN_TOKEN (default verify-admin-token)
 * - VERIFY_PROFILE_ID (required)
 */
import process from 'node:process'
import fs from 'node:fs/promises'
import path from 'node:path'

const BASE = process.env.VERIFY_BACKEND_BASE_URL || 'http://127.0.0.1:19181'
const TOKEN = process.env.VERIFY_ADMIN_TOKEN || 'verify-admin-token'
const PROFILE_ID = process.env.VERIFY_PROFILE_ID || ''

const OUT_PATH = 'docs/verification/uploads-persistence.json'

function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${TOKEN}`, ...extra }
}

async function fetchOk(url, init) {
  const res = await fetch(url, init)
  return { ok: res.ok, status: res.status, headers: Object.fromEntries(res.headers.entries()), res }
}

async function uploadAvatar() {
  const avatarPath = 'public/vite.svg'
  const buf = await fs.readFile(avatarPath)
  const form = new FormData()
  form.append('avatar', new Blob([buf], { type: 'image/svg+xml' }), 'vite.svg')
  const r = await fetchOk(`${BASE}/api/profiles/${encodeURIComponent(PROFILE_ID)}/avatar`, {
    method: 'POST',
    headers: authHeaders(),
    body: form,
  })
  const json = await r.res.json().catch(() => null)
  if (!r.ok) throw new Error(`avatar upload failed: ${r.status} ${JSON.stringify(json)}`)
  return json
}

async function uploadDocument() {
  const tmpText = `GrantFlow upload persistence test\n${new Date().toISOString()}\n`
  const tmpPath = path.join(process.cwd(), 'backend', 'data', `upload-persist-${Date.now()}.txt`)
  await fs.mkdir(path.dirname(tmpPath), { recursive: true })
  await fs.writeFile(tmpPath, tmpText, 'utf8')
  const buf = await fs.readFile(tmpPath)

  const form = new FormData()
  form.append('profile_id', PROFILE_ID)
  form.append('name', 'upload-persist-test.txt')
  form.append('document', new Blob([buf], { type: 'text/plain' }), 'upload-persist-test.txt')

  const r = await fetchOk(`${BASE}/api/documents/ingest`, {
    method: 'POST',
    headers: authHeaders(),
    body: form,
  })
  const json = await r.res.json().catch(() => null)
  if (!r.ok) throw new Error(`document ingest failed: ${r.status} ${JSON.stringify(json)}`)
  return json
}

async function getDocument(documentId) {
  const r = await fetchOk(`${BASE}/api/documents/${encodeURIComponent(documentId)}`, {
    headers: authHeaders(),
  })
  const json = await r.res.json().catch(() => null)
  if (!r.ok) throw new Error(`get document failed: ${r.status} ${JSON.stringify(json)}`)
  return json
}

async function getProfile() {
  const r = await fetchOk(`${BASE}/api/profiles/${encodeURIComponent(PROFILE_ID)}`, {
    headers: authHeaders(),
  })
  const json = await r.res.json().catch(() => null)
  if (!r.ok) throw new Error(`get profile failed: ${r.status} ${JSON.stringify(json)}`)
  return json
}

async function verifyUrl(url) {
  const r = await fetchOk(url, { headers: authHeaders() })
  // Drain body to avoid socket leaks
  await r.res.arrayBuffer().catch(() => null)
  return { ok: r.ok, status: r.status, content_type: r.headers['content-type'] || null }
}

async function run() {
  if (!PROFILE_ID) throw new Error('VERIFY_PROFILE_ID is required')

  let state = null
  try {
    state = JSON.parse(await fs.readFile(OUT_PATH, 'utf8'))
  } catch {
    state = null
  }

  if (!state || state.profile_id !== PROFILE_ID) {
    const avatarRes = await uploadAvatar()
    const profile = await getProfile()
    const docRes = await uploadDocument()
    const documentId = docRes?.document?.id || docRes?.id || null
    const docRow = documentId ? await getDocument(documentId) : null

    state = {
      at: new Date().toISOString(),
      backend: BASE,
      profile_id: PROFILE_ID,
      avatar: {
        upload_response: avatarRes,
        avatar_url: profile?.avatar_url || null,
        avatar_download_url: profile?.avatar_download_url ? `${BASE}${profile.avatar_download_url}` : null,
      },
      document: {
        ingest_response: docRes,
        document_id: documentId,
        document_row: docRow,
        download_url: docRow?.download_url ? `${BASE}${docRow.download_url}` : null,
      },
    }
    await fs.mkdir(path.dirname(OUT_PATH), { recursive: true })
    await fs.writeFile(OUT_PATH, JSON.stringify(state, null, 2), 'utf8')
  }

  const avatarUrl = state?.avatar?.avatar_download_url
  const docUrl = state?.document?.download_url
  if (!avatarUrl || !docUrl) {
    throw new Error(`Missing persisted URLs in ${OUT_PATH}`)
  }

  const avatarCheck = await verifyUrl(avatarUrl)
  const docCheck = await verifyUrl(docUrl)

  console.log(
    JSON.stringify(
      {
        ok: true,
        persisted_state_path: OUT_PATH,
        avatar_check: avatarCheck,
        document_check: docCheck,
      },
      null,
      2,
    ),
  )
}

run().catch((err) => {
  console.error('[uploads-persistence] failed:', err?.stack || err)
  process.exit(1)
})

