#!/usr/bin/env node
/**
 * Drive nationwide ZIP coverage toward a bounded target.
 *
 * This script mutates the configured GrantFlow deployment. It deliberately
 * has no URL, account, password, or token defaults. The operator must name the
 * target host twice so a copied command cannot silently operate on production.
 *
 * Required:
 *   GF_API=https://api.example.com/api
 *   GF_CONFIRM_MUTATING_HOST=api.example.com
 *   GF_ADMIN_TOKEN=...                         # preferred
 *     or GF_ADMIN_EMAIL=... GF_ADMIN_PASSWORD=...
 *
 * Example:
 *   GF_API=https://api.example.com/api \
 *   GF_CONFIRM_MUTATING_HOST=api.example.com \
 *   GF_ADMIN_TOKEN=... \
 *   node scripts/admin-geocrawl-until-complete.mjs \
 *     --max-runs=8 --target-percent=99 --max-zips=5000
 */

import process from 'node:process'

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const match = arg.match(/^--([^=]+)=(.*)$/)
    return match ? [match[1], match[2]] : [arg.replace(/^--/, ''), 'true']
  }),
)

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim()
  if (!value) throw new Error(`${name} is required; this mutating script has no live defaults`)
  return value
}

function boundedInteger(value, { name, min, max }) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`)
  }
  return parsed
}

function boundedNumber(value, { name, min, max }) {
  const parsed = Number.parseFloat(value)
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be a number from ${min} to ${max}`)
  }
  return parsed
}

const apiUrl = new URL(requiredEnv('GF_API'))
const isLoopback = ['127.0.0.1', '::1', 'localhost'].includes(apiUrl.hostname.toLowerCase())
if (apiUrl.protocol !== 'https:' && !(apiUrl.protocol === 'http:' && isLoopback)) {
  throw new Error('GF_API must use HTTPS unless it targets loopback')
}
if (apiUrl.username || apiUrl.password || apiUrl.search || apiUrl.hash) {
  throw new Error('GF_API must not contain credentials, query parameters, or a fragment')
}
const confirmedHost = requiredEnv('GF_CONFIRM_MUTATING_HOST').toLowerCase()
if (confirmedHost !== apiUrl.hostname.toLowerCase()) {
  throw new Error('GF_CONFIRM_MUTATING_HOST must exactly match the GF_API hostname')
}

const API = apiUrl.toString().replace(/\/$/, '')
const ADMIN_TOKEN = String(process.env.GF_ADMIN_TOKEN || '').trim()
const EMAIL = String(process.env.GF_ADMIN_EMAIL || '').trim()
const PASSWORD = String(process.env.GF_ADMIN_PASSWORD || '')
if (!ADMIN_TOKEN && (!EMAIL || !PASSWORD)) {
  throw new Error('set GF_ADMIN_TOKEN, or both GF_ADMIN_EMAIL and GF_ADMIN_PASSWORD')
}

const MAX_RUNS = boundedInteger(args['max-runs'] || '12', { name: 'max-runs', min: 1, max: 100 })
const TARGET_PERCENT = boundedNumber(args['target-percent'] || '99', { name: 'target-percent', min: 0, max: 100 })
const MAX_ZIPS = boundedInteger(args['max-zips'] || '5000', { name: 'max-zips', min: 1, max: 50_000 })
const POLL_INTERVAL_MS = boundedInteger(args['poll-ms'] || '60000', { name: 'poll-ms', min: 1_000, max: 900_000 })
const COUNTRIES = String(process.env.GF_COUNTRIES || 'US,CA')
  .split(',')
  .map((country) => country.trim().toUpperCase())
  .filter(Boolean)
if (COUNTRIES.length === 0 || COUNTRIES.some((country) => !/^[A-Z]{2}$/.test(country))) {
  throw new Error('GF_COUNTRIES must contain comma-separated two-letter country codes')
}

const RUN_PARAMS = Object.freeze({
  countries: COUNTRIES,
  discover_local_resources: true,
  offline_only: false,
  max_zips: MAX_ZIPS,
  min_sources_per_zip: 3,
  rate_limit_ms: 600,
  resume: true,
  skip_domain_corpus: true,
})

let token = ADMIN_TOKEN || null

async function login() {
  const response = await fetch(`${API}/auth/password/login`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  })
  if (!response.ok) throw new Error(`login failed: ${response.status}`)
  const body = await response.json()
  if (!body?.accessToken) throw new Error('login response did not include an access token')
  token = body.accessToken
  return token
}

async function api(path, init = {}) {
  if (!token) await login()
  const request = () => fetch(`${API}${path}`, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  })
  let response = await request()
  if (response.status === 401 && !ADMIN_TOKEN) {
    await login()
    response = await request()
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`${path} -> ${response.status}: ${text.slice(0, 300)}`)
  }
  return response.json()
}

function timestamp() {
  return new Date().toISOString().replace('T', ' ').replace(/\..+$/, '')
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function getStatus() {
  return api('/admin/geo/crawl/status')
}

async function getCoverage() {
  return api('/admin/geo/zip-coverage')
}

async function startRun() {
  return api('/admin/geo/crawl/start', {
    method: 'POST',
    body: JSON.stringify(RUN_PARAMS),
  })
}

async function waitForJobToFinish(jobId) {
  let lastReport = 0
  while (true) {
    let status
    try {
      status = await getStatus()
    } catch (error) {
      console.warn(`[${timestamp()}] status poll error: ${error.message}; backing off`)
      await sleep(15_000)
      continue
    }
    const current = status.geo_crawl
    if (!current || current.id !== jobId) {
      console.warn(`[${timestamp()}] active job changed; exiting wait without starting a replacement`)
      return current || null
    }
    const now = Date.now()
    if (now - lastReport > 5 * 60_000 || current.status !== 'running') {
      console.log(
        `[${timestamp()}] job ${current.id.slice(0, 8)} status=${current.status} processed=${current.processed} inserted=${current.inserted}`,
      )
      lastReport = now
    }
    if (!['running', 'queued'].includes(current.status)) return current
    await sleep(POLL_INTERVAL_MS)
  }
}

async function main() {
  console.log(`[${timestamp()}] === admin-geocrawl-until-complete starting ===`)
  console.log(`[${timestamp()}] host=${apiUrl.hostname} max_runs=${MAX_RUNS} target=${TARGET_PERCENT}% max_zips=${MAX_ZIPS}`)

  let runIndex = 0
  let lastProcessed = -1
  const initial = await getStatus()
  if (initial.geo_crawl && ['running', 'queued'].includes(initial.geo_crawl.status)) {
    console.log(`[${timestamp()}] an existing job is active; waiting without launching another`)
    const final = await waitForJobToFinish(initial.geo_crawl.id)
    runIndex += 1
    lastProcessed = Number(final?.processed ?? 0)
  }

  while (runIndex < MAX_RUNS) {
    const coverage = await getCoverage()
    console.log(
      `[${timestamp()}] coverage=${coverage.coverage_percent}% completed=${coverage.progress_completed}/${coverage.total_us_zips} uncovered=${coverage.uncovered_zip_count}`,
    )
    if (coverage.coverage_percent >= TARGET_PERCENT || coverage.uncovered_zip_count === 0 || lastProcessed === 0) break

    runIndex += 1
    console.log(`[${timestamp()}] launching run ${runIndex}/${MAX_RUNS}`)
    let started
    try {
      started = await startRun()
    } catch (error) {
      console.warn(`[${timestamp()}] start failed: ${error.message}; retrying in 30s`)
      await sleep(30_000)
      continue
    }
    const jobId = started.job?.id
    if (!jobId) throw new Error('crawl start response did not include a job id')
    const final = await waitForJobToFinish(jobId)
    lastProcessed = Number(final?.processed ?? 0)
    await sleep(15_000)
  }

  const finalCoverage = await getCoverage()
  console.log(`[${timestamp()}] === FINAL COVERAGE ===`)
  console.log(
    `[${timestamp()}] coverage=${finalCoverage.coverage_percent}% completed=${finalCoverage.progress_completed}/${finalCoverage.total_us_zips} uncovered=${finalCoverage.uncovered_zip_count}`,
  )
}

main().catch((error) => {
  console.error(`[${timestamp()}] FATAL: ${error.message}`)
  process.exitCode = 1
})
