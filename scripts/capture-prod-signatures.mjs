#!/usr/bin/env node
/**
 * Capture stable HTTP signatures for prod triage (read-only).
 *
 * Usage:
 *   node scripts/capture-prod-signatures.mjs
 *
 * Notes:
 * - Designed to generate copy/paste-able evidence for docs/ERROR_LEDGER.md
 * - Does not require auth; does not write any data.
 */

import process from 'node:process'

const URLS = [
  'https://app.axiombiolabs.org/grantflow/',
  'https://app.axiombiolabs.org/grantflow/login',
  'https://app.axiombiolabs.org/grantflow/api/health',
  'https://www.axiombiolabs.org/grantflow/',
  'https://www.axiombiolabs.org/grantflow/login',
  'https://www.axiombiolabs.org/grantflow/api/health',
  'https://axiombiolabs.org/grantflow/',
  'https://axiombiolabs.org/grantflow/login',
  'https://axiombiolabs.org/grantflow/api/health',
]

async function fetchWithTimeout(url, { timeoutMs = 15_000 } = {}) {
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { redirect: 'manual', signal: controller.signal })
  } finally {
    clearTimeout(id)
  }
}

function headerPick(headers, name) {
  const v = headers.get(name)
  return v ? String(v) : null
}

function normalizeSnippet(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220)
}

async function captureOne(url) {
  const res = await fetchWithTimeout(url)
  const text = await res.text().catch(() => '')

  return {
    url,
    status: res.status,
    server: headerPick(res.headers, 'server'),
    content_type: headerPick(res.headers, 'content-type'),
    location: headerPick(res.headers, 'location'),
    x_request_id: headerPick(res.headers, 'x-request-id'),
    x_vercel_id: headerPick(res.headers, 'x-vercel-id'),
    cf_ray: headerPick(res.headers, 'cf-ray'),
    body_snippet: normalizeSnippet(text),
  }
}

async function run() {
  const results = []
  for (const url of URLS) {
    // eslint-disable-next-line no-console
    console.log(`\n=== ${url} ===`)
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await captureOne(url)
      results.push(r)
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(r, null, 2))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // eslint-disable-next-line no-console
      console.error(`[capture] error: ${msg}`)
      results.push({ url, error: msg })
    }
  }

  // eslint-disable-next-line no-console
  console.log('\n---\nCopy/paste summary (compact):\n')
  for (const r of results) {
    // eslint-disable-next-line no-console
    console.log(
      `${r.url} :: ${r.status ?? 'ERR'} :: server=${r.server ?? '-'} x-vercel-id=${r.x_vercel_id ?? '-'} x-request-id=${r.x_request_id ?? '-'} snippet="${(r.body_snippet ?? '').slice(0, 120)}"`,
    )
  }

  // If any failures, exit non-zero so this can be used in CI smoke later if desired.
  const anyNonOk = results.some((r) => typeof r.status === 'number' && r.status >= 400)
  if (anyNonOk) process.exitCode = 2
}

run().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('[capture] fatal:', e instanceof Error ? e.stack : e)
  process.exitCode = 1
})

