#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..')

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

function fail(message) {
  console.error(`[profile-crawl-audit] FAIL: ${message}`)
  process.exitCode = 1
}

function pass(message) {
  console.log(`[profile-crawl-audit] OK: ${message}`)
}

const crawlersRoute = read('backend/routes/crawlers.js')
const dispatcher = read('backend/services/crawlerDispatcher.js')
const jobCreation = read('backend/services/crawlerJobCreation.js')
const realCrawlers = read('backend/routes/realCrawlers.js')

if (crawlersRoute.includes('buildSnapshot: false')) {
  fail('backend/routes/crawlers.js still creates crawler jobs with buildSnapshot: false. Profile-aware crawls should persist a snapshot at creation time.')
} else {
  pass('crawler job creation does not explicitly disable snapshots')
}

const requiredTypes = [
  'local',
  'scholarship',
  'health_resources',
  'avatar_lookup',
  'document_ingest',
  'profile_enrichment',
  'government_funding',
  'student_grants',
  'ecf_benefits',
  'special_needs',
  'local_funding',
  'item_matching',
]

const missingTypes = requiredTypes.filter((type) => !crawlersRoute.includes(`'${type}'`))
if (missingTypes.length > 0) {
  fail(`backend/routes/crawlers.js is missing profile-required enforcement for: ${missingTypes.join(', ')}`)
} else {
  pass('profile-required crawler types are enumerated in backend/routes/crawlers.js')
}

if (!dispatcher.includes('restoreContextFromSnapshot')) {
  fail('backend/services/crawlerDispatcher.js must restore persisted profile snapshots before dispatching jobs')
} else {
  pass('crawler dispatcher restores persisted profile snapshots')
}

if (!jobCreation.includes('profileContextSnapshot')) {
  fail('backend/services/crawlerJobCreation.js must persist profileContextSnapshot for profile-scoped jobs')
} else {
  pass('crawler job creation supports persisted profile snapshots')
}

if (!realCrawlers.includes('profileContext')) {
  fail('backend/routes/realCrawlers.js should pass explicit profileContext into crawlers to prevent live re-query contamination')
} else {
  pass('real crawlers pass explicit profile context')
}

if (process.exitCode && process.exitCode !== 0) {
  console.error('[profile-crawl-audit] One or more profile-integrity checks failed.')
} else {
  console.log('[profile-crawl-audit] All profile-integrity checks passed.')
}
