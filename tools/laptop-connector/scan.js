#!/usr/bin/env node
/**
 * laptop-connector / scan.js
 *
 * Runs on the admin's laptop. Walks allowlisted roots, skips the denylist,
 * extracts text from documents LOCALLY, and POSTs text + provenance to the
 * GrantFlow backend, which stages candidates for check-off. Raw bytes never
 * leave the machine.
 *
 * Usage:
 *   node tools/laptop-connector/scan.js                 # uses config.json
 *   node tools/laptop-connector/scan.js --dry-run       # list, send nothing
 *
 * Auth: set LAPTOP_CONNECTOR_TOKEN (or ADMIN_TOKEN) to the backend admin token.
 * API:  set LAPTOP_CONNECTOR_API or config.apiBaseUrl to the backend URL.
 *
 * Run from the repo root so node_modules (mammoth, pdf-parse) resolve.
 */

import { promises as fsp } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractText } from '../../backend/services/documentIngestion/extractText.js'
import { buildDenylist, isDenied } from './denylist.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CONNECTOR_VERSION = '1.0.0'

async function loadConfig() {
  const explicit = path.join(HERE, 'config.json')
  const example = path.join(HERE, 'config.example.json')
  for (const file of [explicit, example]) {
    try {
      const raw = await fsp.readFile(file, 'utf8')
      const cfg = JSON.parse(raw)
      if (file === example) {
        console.warn('[connector] config.json not found — using config.example.json defaults.')
      }
      return cfg
    } catch {
      /* try next */
    }
  }
  throw new Error('No config.json or config.example.json found in ' + HERE)
}

function sha256File(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

async function* walk(dir, denied) {
  let entries = []
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return // unreadable dir (permissions) — skip silently
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (isDenied(full, denied)) continue
    if (entry.isDirectory()) {
      yield* walk(full, denied)
    } else if (entry.isFile()) {
      yield full
    }
  }
}

async function postJson(url, token, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  let parsed = null
  try {
    parsed = await r.json()
  } catch {
    parsed = null
  }
  return { ok: r.ok, status: r.status, body: parsed }
}

async function main() {
  const dryFlag = process.argv.includes('--dry-run')
  const cfg = await loadConfig()
  const dryRun = dryFlag || cfg.dryRun === true

  const apiBaseUrl = (process.env.LAPTOP_CONNECTOR_API || cfg.apiBaseUrl || '').replace(/\/+$/, '')
  const token = process.env.LAPTOP_CONNECTOR_TOKEN || process.env.ADMIN_TOKEN || cfg.token || ''
  if (!dryRun && (!apiBaseUrl || /YOUR-GRANTFLOW/.test(apiBaseUrl))) {
    throw new Error('Set apiBaseUrl (config.json) or LAPTOP_CONNECTOR_API env to your backend URL.')
  }
  if (!dryRun && !token) {
    throw new Error('Set LAPTOP_CONNECTOR_TOKEN (or ADMIN_TOKEN) to the backend admin token.')
  }

  const denied = buildDenylist(cfg.extraDenylist)
  const exts = new Set((cfg.extensions || ['.pdf', '.docx', '.txt', '.md', '.rtf', '.csv']).map((e) => e.toLowerCase()))
  const maxBytes = (Number(cfg.maxFileSizeMB) || 15) * 1024 * 1024
  const minTextChars = Number(cfg.minTextChars) || 120
  const roots = (cfg.roots || []).filter(Boolean)

  console.log(`[connector] roots=${JSON.stringify(roots)} dryRun=${dryRun} exts=${[...exts].join(',')}`)
  console.log(`[connector] ${denied.length} denylist segments active (regulated + system folders excluded)`)

  // Start a run (skip in dry mode).
  let runId = null
  if (!dryRun) {
    const host = process.env.COMPUTERNAME || process.env.HOSTNAME || 'laptop'
    const started = await postJson(`${apiBaseUrl}/api/laptop-connector/runs`, token, {
      host,
      connector_version: CONNECTOR_VERSION,
      root_paths: roots,
    })
    if (!started.ok) throw new Error(`Failed to start run: ${started.status} ${JSON.stringify(started.body)}`)
    runId = started.body.run_id
    console.log(`[connector] run started: ${runId}`)
  }

  const stats = { scanned: 0, skippedExt: 0, skippedSize: 0, skippedEmpty: 0, ingested: 0, candidates: 0, errors: 0 }

  async function processFile(file) {
    const ext = path.extname(file).toLowerCase()
    if (!exts.has(ext)) {
      stats.skippedExt += 1
      return
    }
    let st
    try {
      st = await fsp.stat(file)
    } catch {
      return
    }
    if (st.size > maxBytes) {
      stats.skippedSize += 1
      return
    }
    stats.scanned += 1

    let buffer
    try {
      buffer = await fsp.readFile(file)
    } catch {
      return
    }
    const hash = sha256File(buffer)
    const fileType = ext.replace('.', '')

    let extracted
    try {
      extracted = await extractText({ filePath: file, fileName: path.basename(file) })
    } catch (err) {
      stats.errors += 1
      return
    }
    const text = extracted?.text || ''
    if (text.trim().length < minTextChars) {
      stats.skippedEmpty += 1
      return
    }

    if (dryRun) {
      console.log(`  WOULD INGEST  ${file}  (${text.length} chars)`)
      stats.ingested += 1
      return
    }

    const resp = await postJson(`${apiBaseUrl}/api/laptop-connector/runs/${runId}/ingest`, token, {
      file_path: file,
      file_name: path.basename(file),
      file_type: fileType,
      file_hash: hash,
      byte_size: st.size,
      modified_at: st.mtime.toISOString(),
      text,
    })
    if (!resp.ok) {
      stats.errors += 1
      console.warn(`  ingest failed (${resp.status}): ${file}`)
      return
    }
    if (resp.body?.skipped) return
    stats.ingested += 1
    stats.candidates += resp.body?.candidates_created || 0
    if (resp.body?.candidates_created) {
      console.log(`  +${resp.body.candidates_created} candidate(s): ${path.basename(file)}`)
    }
  }

  // Simple bounded-concurrency pool over the file stream.
  const concurrency = Math.max(1, Number(cfg.concurrency) || 3)
  const inFlight = new Set()
  for (const root of roots) {
    for await (const file of walk(root, denied)) {
      const task = processFile(file).catch((err) => {
        stats.errors += 1
        console.warn(`  error: ${file}: ${err?.message}`)
      })
      inFlight.add(task)
      task.finally(() => inFlight.delete(task))
      if (inFlight.size >= concurrency) await Promise.race(inFlight)
    }
  }
  await Promise.allSettled(inFlight)

  if (!dryRun && runId) {
    await postJson(`${apiBaseUrl}/api/laptop-connector/runs/${runId}/complete`, token, {
      status: 'completed',
      summary: stats,
    })
  }

  console.log('\n[connector] done:', JSON.stringify(stats, null, 2))
  if (!dryRun) {
    console.log(`[connector] Review candidates in GrantFlow → Laptop Inbox (or GET /api/laptop-connector/review).`)
  }
}

main().catch((err) => {
  console.error('[connector] FATAL:', err?.message || err)
  process.exit(1)
})
