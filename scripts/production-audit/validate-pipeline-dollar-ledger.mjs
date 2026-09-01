#!/usr/bin/env node
/** Fail-closed validator for the pipeline-dollar production ledger artifact. */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findSecrets } from './redact.mjs'

const FORBIDDEN_KEYS = /(?:email|phone|address|dob|birth|ssn|password|credential|token|secret|cookie|session|cipher|application_text|document|essay)/i
const ALLOWED_TOP_LEVEL = new Set(['audit', 'generated_at', 'contract', 'scope', 'safety', 'summary', 'profiles'])
const MAX_SCOPED_PROFILES = 200
const PROFILE_ID_RE = /^[A-Za-z0-9._:-]{1,160}$/

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
}

function validateScope(scope) {
  if (!Array.isArray(scope) || scope.length === 0) {
    throw new Error('scope must be a non-empty profile-id array')
  }
  if (scope.length > MAX_SCOPED_PROFILES) {
    throw new Error(`scope exceeds ${MAX_SCOPED_PROFILES} profile ids`)
  }
  const normalized = scope.map((value) => String(value || '').trim())
  for (const id of normalized) {
    if (!PROFILE_ID_RE.test(id)) throw new Error(`invalid scoped profile id: ${id || '(empty)'}`)
  }
  if (new Set(normalized).size !== normalized.length) {
    throw new Error('scope contains duplicate profile ids')
  }
  return new Set(normalized)
}

function scanForbiddenKeys(value, trail = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForbiddenKeys(item, [...trail, String(index)]))
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    const next = [...trail, key]
    if (FORBIDDEN_KEYS.test(key)) throw new Error(`forbidden key in artifact: ${next.join('.')}`)
    scanForbiddenKeys(child, next)
  }
}

export function validatePipelineDollarLedgerObject(ledger) {
  assertObject(ledger, 'ledger')
  if (ledger.audit !== 'grantflow-pipeline-dollar-ledger') throw new Error('unexpected audit type')
  for (const key of Object.keys(ledger)) {
    if (!ALLOWED_TOP_LEVEL.has(key)) throw new Error(`unexpected top-level key: ${key}`)
  }
  const scopedProfileIds = validateScope(ledger.scope)
  assertObject(ledger.contract, 'contract')
  assertObject(ledger.safety, 'safety')
  assertObject(ledger.summary, 'summary')
  if (!Array.isArray(ledger.profiles)) throw new Error('profiles must be an array')
  if (ledger.safety.database_role !== 'grantflow_auditor') throw new Error('wrong database role')
  if (ledger.safety.non_superuser !== true) throw new Error('non-superuser proof missing')
  if (ledger.safety.transaction_read_only !== true) throw new Error('read-only proof missing')
  if (Number(ledger.safety.rows_mutated) !== 0) throw new Error('artifact reports mutated rows')
  if (Number(ledger.summary.profiles) !== ledger.profiles.length) throw new Error('profile count mismatch')

  const reportedProfileIds = new Set()
  for (const profile of ledger.profiles) {
    assertObject(profile, 'profile')
    const profileId = String(profile.profile_id || '').trim()
    if (!PROFILE_ID_RE.test(profileId)) throw new Error('profile_id missing or invalid')
    if (!scopedProfileIds.has(profileId)) throw new Error(`reported profile is outside scope: ${profileId}`)
    if (reportedProfileIds.has(profileId)) throw new Error(`duplicate reported profile: ${profileId}`)
    reportedProfileIds.add(profileId)

    for (const key of ['old_total', 'corrected_total', 'overstatement']) {
      const value = Number(profile[key])
      if (!Number.isFinite(value) || value < 0) throw new Error(`${key} is invalid`)
    }
    const expectedDelta = Math.max(0, Number(profile.old_total) - Number(profile.corrected_total))
    if (Math.abs(expectedDelta - Number(profile.overstatement)) > 0.011) {
      throw new Error(`overstatement mismatch for ${profileId}`)
    }
    if (!Array.isArray(profile.top_inflation_contributors)) throw new Error('top contributors missing')
    if (profile.top_inflation_contributors.length > 20) throw new Error('top contributors exceeds 20')
    for (const row of profile.top_inflation_contributors) {
      if (!(Number(row.overstatement) > 0)) throw new Error('non-positive row in inflation contributors')
    }
  }

  scanForbiddenKeys(ledger)
  return true
}

export function validatePipelineDollarLedgerFile(file) {
  const text = fs.readFileSync(file, 'utf8')
  const hits = findSecrets(text, { where: path.basename(file) })
  if (hits.length) {
    throw new Error(`credential material detected: ${hits.map((hit) => hit.rule).join(', ')}`)
  }
  const parsed = JSON.parse(text)
  validatePipelineDollarLedgerObject(parsed)
  return parsed
}

function selfTest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-dollar-ledger-validator-'))
  const clean = {
    audit: 'grantflow-pipeline-dollar-ledger',
    generated_at: '2026-09-01T00:00:00.000Z',
    contract: {},
    scope: ['p1'],
    safety: {
      database_role: 'grantflow_auditor',
      database: 'grantflow',
      non_superuser: true,
      transaction_read_only: true,
      rows_mutated: 0,
    },
    summary: { profiles: 1 },
    profiles: [{
      profile_id: 'p1', display_name: 'Example', old_total: 100, corrected_total: 50,
      overstatement: 50, top_inflation_contributors: [{ overstatement: 50 }],
    }],
  }
  const cleanFile = path.join(dir, 'clean.json')
  fs.writeFileSync(cleanFile, JSON.stringify(clean))
  validatePipelineDollarLedgerFile(cleanFile)

  const unsafeFile = path.join(dir, 'unsafe.json')
  const unsafe = structuredClone(clean)
  unsafe.profiles[0].password = 'not-allowed'
  fs.writeFileSync(unsafeFile, JSON.stringify(unsafe))
  let refused = false
  try {
    validatePipelineDollarLedgerFile(unsafeFile)
  } catch {
    refused = true
  }

  const mismatchedFile = path.join(dir, 'mismatched.json')
  const mismatched = structuredClone(clean)
  mismatched.scope = ['other-profile']
  fs.writeFileSync(mismatchedFile, JSON.stringify(mismatched))
  let mismatchRefused = false
  try {
    validatePipelineDollarLedgerFile(mismatchedFile)
  } catch {
    mismatchRefused = true
  }

  fs.rmSync(dir, { recursive: true, force: true })
  if (!refused) throw new Error('validator failed to reject planted private field')
  if (!mismatchRefused) throw new Error('validator failed to reject a scope mismatch')
  console.log('pipeline-dollar ledger validator self-test passed')
}

function main() {
  const args = process.argv.slice(2)
  if (args.includes('--self-test')) return selfTest()
  const index = args.indexOf('--file')
  const file = index >= 0 && args[index + 1]
    ? args[index + 1]
    : path.join(process.cwd(), 'audit-out', 'pipeline-dollar-ledger.json')
  const parsed = validatePipelineDollarLedgerFile(file)
  console.log(JSON.stringify({
    ok: true,
    profiles: parsed.summary.profiles,
    old_total: parsed.summary.old_total,
    corrected_total: parsed.summary.corrected_total,
    overstatement: parsed.summary.overstatement,
  }))
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    main()
  } catch (error) {
    console.error(`ARTIFACT REJECTED: ${error?.message || String(error)}`)
    process.exit(1)
  }
}
