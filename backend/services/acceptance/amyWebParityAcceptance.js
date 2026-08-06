/**
 * Hermetic release acceptance for GrantFlow's exact-50 Amy cohort and the
 * same cohort's live plain-web parity benchmark.
 *
 * This module intentionally imports only Node built-ins. The operator path
 * scrubs database and outbound-email configuration, creates a disposable
 * SQLite database, runs migrations in a fresh process, and only then
 * dynamically imports application modules. It never starts the server,
 * schedulers, or a production connection.
 */

import crypto from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'

const execFile = promisify(execFileCallback)

export const ACCEPTANCE_TARGET = 50
export const ACCEPTANCE_SCHEMA_VERSION = 'grantflow-amy-web-parity-acceptance-v1'
export const ACCEPTANCE_NODE_VERSION = '20.20.2'
export const COMPETITIVENESS_POLICY_RELATIVE_PATH = 'config/web-parity-acceptance-policy.json'
export const DEFAULT_ALLOWED_PROVIDERS = Object.freeze([
  'google_cse',
  'searxng',
  'brave',
])

export const ACCEPTANCE_EXIT = Object.freeze({
  PASS: 0,
  PREFLIGHT: 2,
  RUNTIME: 3,
  AMY: 4,
  PARITY: 5,
  POLICY_BLOCKED: 6,
  CLEANUP: 7,
  RECEIPT_WRITE: 8,
})

const SHA_RE = /^[0-9a-f]{40}$/i
const JSON_SUFFIX_RE = /\.json$/i
const POLICY_SCHEMA_VERSION = 1
const POLICY_OWNER = 'Dr. John White / Axiom BioLabs'

class AcceptanceFailure extends Error {
  constructor(message, { stage, exitCode, details = null } = {}) {
    super(message)
    this.name = 'AcceptanceFailure'
    this.stage = stage || 'unknown'
    this.exitCode = exitCode ?? ACCEPTANCE_EXIT.RUNTIME
    this.details = details
  }
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value ?? '').trim())
    .filter(Boolean))]
}

function sameMembers(left, right) {
  const a = uniqueStrings(left).sort()
  const b = uniqueStrings(right).sort()
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function safeError(error) {
  return {
    name: String(error?.name || 'Error'),
    message: String(error?.message || error || 'unknown error').slice(0, 1000),
    stage: error?.stage || null,
  }
}

function addCheck(receipt, name, ok, evidence = null) {
  receipt.checks.push({ name, ok: Boolean(ok), evidence })
  return Boolean(ok)
}

function fail(message, stage, exitCode, details = null) {
  throw new AcceptanceFailure(message, { stage, exitCode, details })
}

function isInside(parent, child) {
  const relative = path.relative(parent, child)
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
}

async function assertDirectoryChainHasNoSymlink(root, targetParent) {
  const relative = path.relative(root, targetParent)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('output parent escapes audit-reports')
  }

  let current = root
  const parts = relative === '' ? [] : relative.split(path.sep)
  for (const part of ['', ...parts]) {
    if (part) current = path.join(current, part)
    try {
      const stat = await fs.lstat(current)
      if (stat.isSymbolicLink()) throw new Error(`output path contains a symlink: ${current}`)
      if (!stat.isDirectory()) throw new Error(`output parent is not a directory: ${current}`)
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
  }
}

/**
 * Resolve an operator-selected receipt path. Receipts may only live below the
 * repository's real audit-reports directory. Existing targets, symlinks, and
 * non-regular paths are rejected so a run cannot replace prior evidence.
 */
export async function resolveControlledOutputPath(repoRoot, rawOutput) {
  const root = path.resolve(String(repoRoot || ''))
  const auditRoot = path.join(root, 'audit-reports')
  const output = path.resolve(root, String(rawOutput || ''))

  if (!rawOutput) throw new Error('--output is required')
  if (!JSON_SUFFIX_RE.test(output)) throw new Error('--output must name a .json receipt')
  if (!isInside(auditRoot, output)) throw new Error('--output must be below the repository audit-reports directory')

  const auditStat = await fs.lstat(auditRoot)
  if (auditStat.isSymbolicLink() || !auditStat.isDirectory()) {
    throw new Error('repository audit-reports must be a real directory, not a symlink')
  }
  const realAuditRoot = await fs.realpath(auditRoot)
  if (realAuditRoot !== auditRoot) throw new Error('repository audit-reports path is not canonical')

  await assertDirectoryChainHasNoSymlink(auditRoot, path.dirname(output))
  try {
    await fs.lstat(output)
    throw new Error('the --output receipt already exists; choose a new evidence path')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  return output
}

function resolveControlledOutputCandidate(repoRoot, rawOutput) {
  const root = path.resolve(String(repoRoot || ''))
  const auditRoot = path.join(root, 'audit-reports')
  const output = path.resolve(root, String(rawOutput || ''))

  if (!rawOutput) throw new Error('--output is required')
  if (!JSON_SUFFIX_RE.test(output)) throw new Error('--output must name a .json receipt')
  if (!isInside(auditRoot, output)) {
    throw new Error('--output must be below the repository audit-reports directory')
  }
  return output
}

async function ensureControlledAuditRoot(repoRoot) {
  const root = path.resolve(String(repoRoot || ''))
  const realRoot = await fs.realpath(root)
  if (realRoot !== root) throw new Error('repository root path is not canonical')

  const auditRoot = path.join(root, 'audit-reports')
  try {
    await fs.mkdir(auditRoot, { mode: 0o700 })
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }
  const stat = await fs.lstat(auditRoot)
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('repository audit-reports must be a real directory, not a symlink')
  }
  if (await fs.realpath(auditRoot) !== auditRoot) {
    throw new Error('repository audit-reports path is not canonical')
  }
  return auditRoot
}

export async function writeAtomicReceipt(repoRoot, outputPath, receipt) {
  await ensureControlledAuditRoot(repoRoot)
  const controlled = await resolveControlledOutputPath(repoRoot, outputPath)
  const parent = path.dirname(controlled)
  await fs.mkdir(parent, { recursive: true, mode: 0o700 })
  await assertDirectoryChainHasNoSymlink(path.join(path.resolve(repoRoot), 'audit-reports'), parent)
  await resolveControlledOutputPath(repoRoot, controlled)

  const tempPath = path.join(
    parent,
    `.${path.basename(controlled)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  )
  let handle = null
  try {
    handle = await fs.open(tempPath, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    handle = null
    // Publish the completed, fsync'd file atomically with create-only
    // semantics. link() returns EEXIST rather than overwriting prior evidence.
    await fs.link(tempPath, controlled)
    await fs.unlink(tempPath)
    return controlled
  } finally {
    if (handle) await handle.close().catch(() => {})
    await fs.unlink(tempPath).catch(() => {})
  }
}

export async function inspectGitSource(repoRoot) {
  const options = { cwd: repoRoot, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }
  const [{ stdout: sha }, { stdout: status }] = await Promise.all([
    execFile('git', ['rev-parse', 'HEAD'], options),
    execFile('git', ['status', '--porcelain=v1', '--untracked-files=all'], options),
  ])
  return { sha: String(sha || '').trim(), status: String(status || '') }
}

function isDatabaseEnvironmentKey(key) {
  return key === 'DATABASE_URL' || key === 'SQLITE_DB_PATH' ||
    key.startsWith('PG') || key.startsWith('POSTGRES') || key.startsWith('RAILWAY')
}

function isOutboundEmailEnvironmentKey(key) {
  return /(^|_)EMAIL($|_)/.test(key) ||
    /^(SMTP|RESEND|SENDGRID|MAILGUN|POSTMARK|SES)(_|$)/.test(key)
}

export function installHermeticEnvironment(env, sqlitePath) {
  const snapshot = new Map()
  const touched = new Set()
  const remember = (key) => {
    if (!touched.has(key)) snapshot.set(key, Object.hasOwn(env, key) ? env[key] : undefined)
    touched.add(key)
  }
  const remove = (key) => {
    remember(key)
    delete env[key]
  }
  const set = (key, value) => {
    remember(key)
    env[key] = String(value)
  }

  for (const key of Object.keys(env)) {
    if (isDatabaseEnvironmentKey(key) || isOutboundEmailEnvironmentKey(key)) remove(key)
  }

  set('NODE_ENV', 'acceptance')
  set('DB_PROVIDER', 'sqlite')
  set('DB_DIALECT', 'sqlite')
  set('SQLITE_DB_PATH', sqlitePath)
  set('WEB_DISCOVERY_ENABLED', 'true')
  set('WEB_PARITY_BENCHMARK', 'true')
  set('WEB_SEARCH_CACHE_TTL_HOURS', '0')
  set('AMY_DAILY_PROFILE_TARGET', ACCEPTANCE_TARGET)
  set('AMY_SCHEDULER_ENABLED', 'false')
  set('EMAIL_GRANTS_SYNC_ENABLED', 'false')

  return {
    scrubbed_keys: [...touched].sort(),
    restore() {
      for (const [key, value] of snapshot.entries()) {
        if (value === undefined) delete env[key]
        else env[key] = value
      }
    },
  }
}

export async function runStrictMigrations({ repoRoot, env }) {
  try {
    const { stdout, stderr } = await execFile(
      process.execPath,
      [path.join(repoRoot, 'backend/db/migrate.js')],
      {
        cwd: repoRoot,
        env,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      },
    )
    return {
      ok: true,
      stdout_tail: String(stdout || '').split('\n').slice(-8).join('\n'),
      stderr_tail: String(stderr || '').split('\n').slice(-8).join('\n'),
    }
  } catch (error) {
    throw new AcceptanceFailure('strict SQLite migrations failed', {
      stage: 'migrations',
      exitCode: ACCEPTANCE_EXIT.RUNTIME,
      details: {
        code: error?.code ?? null,
        stdout_tail: String(error?.stdout || '').split('\n').slice(-8).join('\n'),
        stderr_tail: String(error?.stderr || '').split('\n').slice(-8).join('\n'),
      },
    })
  }
}

/** Application imports live here so database/email scrubbing always precedes them. */
export async function loadDefaultAcceptanceRuntime(repoRoot) {
  const fromRepo = (relativePath) => import(pathToFileURL(path.join(repoRoot, relativePath)).href)
  const [
    dbModule,
    amyModule,
    parityModule,
    crawlerModule,
    profileStore,
    deletionProof,
    webSearchModule,
    extractorModule,
  ] = await Promise.all([
    fromRepo('backend/db/index.js'),
    fromRepo('backend/services/amy/amyAgent.js'),
    fromRepo('backend/services/webParityBenchmark.js'),
    fromRepo('backend/services/crawlerOsService.js'),
    fromRepo('backend/services/amy/amyProfileStore.js'),
    fromRepo('backend/services/amy/amyDeletionProof.js'),
    fromRepo('backend/services/shared/webSearchEngine.js'),
    fromRepo('backend/services/webGrantExtractor.js'),
  ])
  return {
    db: dbModule.getDb(),
    runAmyTraining: amyModule.runAmyTraining,
    runWebParityBenchmark: parityModule.runWebParityBenchmark,
    runProfileDiscoveryLive: crawlerModule.runProfileDiscoveryLive,
    cleanupAmyProfiles: profileStore.cleanupAmyProfiles,
    listAmyProfiles: profileStore.listAmyProfiles,
    countAmyProfiles: deletionProof.countAmyProfiles,
    verifyAmyDeletion: deletionProof.verifyAmyDeletion,
    searchWeb: webSearchModule.searchWeb,
    extractOpportunitiesFromPage: extractorModule.extractOpportunitiesFromPage,
  }
}

function configuredSearchProviders(env, allowedProviders) {
  const configured = []
  if (String(env.GOOGLE_CSE_KEY || '').trim() && String(env.GOOGLE_CSE_CX || '').trim()) configured.push('google_cse')
  if (String(env.SEARXNG_URL || '').trim()) configured.push('searxng')
  if (String(env.BRAVE_SEARCH_API_KEY || '').trim()) configured.push('brave')
  const allowed = new Set(allowedProviders)
  return {
    configured,
    selected_configured: configured.filter((provider) => allowed.has(provider)),
  }
}

function configuredExtractorProviders(env) {
  return [
    ...(String(env.OPENAI_API_KEY || '').trim() ? ['openai'] : []),
    ...(String(env.ANTHROPIC_API_KEY || '').trim() ? ['anthropic'] : []),
  ]
}

function boundedProbe(promise, timeoutMs, code) {
  let timer = null
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(code)), timeoutMs)
    }),
  ]).finally(() => clearTimeout(timer))
}

const EXTRACTOR_PROBE_HTML = `<!doctype html>
<html><body><main>
<h1>2026 Community Health Access Grant</h1>
<p>Axiom Community Foundation offers the 2026 Community Health Access Grant to Tennessee nonprofit
organizations that operate community health access programs. Eligible applicants are tax-exempt
nonprofit organizations serving Tennessee residents. Awards range from $5,000 to $10,000. This is
a grant, not a loan, and no cost share is required. Applications are due December 31, 2026.</p>
<p>The program supports community health access, patient transportation, and preventive care.</p>
<a href="https://acceptance-probe.invalid/apply">Apply for the Community Health Access Grant</a>
</main></body></html>`

/**
 * Bounded, live dependency probe run before Amy creates any profiles. Evidence
 * contains provider names/counts only—never API keys, tokens, URLs, headers, or
 * underlying provider error messages.
 */
export async function runDependencyPreflight({
  env,
  allowedProviders,
  searchWeb,
  extractOpportunitiesFromPage,
  searchTimeoutMs = 15_000,
  extractorTimeoutMs = 20_000,
} = {}) {
  const searchConfig = configuredSearchProviders(env || {}, allowedProviders || [])
  const extractorConfigured = configuredExtractorProviders(env || {})
  const evidence = {
    ok: false,
    search: {
      configured_providers: searchConfig.configured,
      selected_configured_providers: searchConfig.selected_configured,
      responsive_provider: null,
      result_count: 0,
      status: 'not_attempted',
      provenance: null,
      reason: null,
    },
    extractor: {
      configured_providers: extractorConfigured,
      responsive: false,
      candidate_count: 0,
      reason: null,
    },
  }

  if (searchConfig.selected_configured.length === 0) {
    evidence.search.status = 'blocked'
    evidence.search.reason = 'no_selected_reliable_search_provider_configured'
    return evidence
  }
  if (extractorConfigured.length === 0) {
    evidence.extractor.reason = 'no_openai_or_anthropic_provider_configured'
    return evidence
  }
  if (typeof searchWeb !== 'function' || typeof extractOpportunitiesFromPage !== 'function') {
    evidence.search.reason = 'preflight_runtime_missing'
    evidence.extractor.reason = 'preflight_runtime_missing'
    return evidence
  }

  try {
    const results = await boundedProbe(
      searchWeb('site:grants.gov "notice of funding opportunity" 2026', { count: 3, timeoutMs: 8_000 }),
      searchTimeoutMs,
      'search_probe_timeout',
    )
    const meta = results?.searchMeta && typeof results.searchMeta === 'object' ? results.searchMeta : null
    const provider = String(meta?.provider || 'unknown').toLowerCase()
    const provenance = String(meta?.provenance || 'unknown').toLowerCase()
    const status = String(meta?.status || 'unknown').toLowerCase()
    const resultCount = Array.isArray(results) ? results.length : 0
    evidence.search = {
      ...evidence.search,
      responsive_provider: provider,
      result_count: resultCount,
      status,
      provenance,
      reason: null,
    }
    const searchOk = searchConfig.selected_configured.includes(provider) &&
      provenance === 'live' && status === 'ok' && resultCount > 0
    if (!searchOk) {
      evidence.search.reason = 'selected_live_search_provider_not_responsive'
      return evidence
    }
  } catch {
    evidence.search.status = 'failed'
    evidence.search.reason = 'search_probe_failed_or_timed_out'
    return evidence
  }

  try {
    const candidates = await boundedProbe(
      extractOpportunitiesFromPage(
        {
          pageUrl: 'https://acceptance-probe.invalid/community-health-grant',
          html: EXTRACTOR_PROBE_HTML,
        },
        { timeoutMs: Math.min(15_000, extractorTimeoutMs) },
      ),
      extractorTimeoutMs,
      'extractor_probe_timeout',
    )
    const valid = (Array.isArray(candidates) ? candidates : []).filter(
      (candidate) => candidate?.raw?.blind_extraction === true &&
        String(candidate?.title || '').trim() && String(candidate?.sponsor || '').trim(),
    )
    evidence.extractor.candidate_count = valid.length
    evidence.extractor.responsive = valid.length > 0
    evidence.extractor.reason = valid.length > 0 ? null : 'extractor_returned_no_evidence_grounded_candidate'
  } catch {
    evidence.extractor.reason = 'extractor_probe_failed_or_timed_out'
  }
  evidence.ok = evidence.search.reason === null && evidence.extractor.responsive
  return evidence
}

export async function validateDisposableTempDirectory(candidate) {
  const raw = String(candidate || '')
  const expectedPrefix = 'grantflow-amy-parity-'
  const realTmpRoot = await fs.realpath(os.tmpdir())
  const resolved = path.resolve(raw)
  const stat = await fs.lstat(resolved)
  const realCandidate = await fs.realpath(resolved)
  const basename = path.basename(resolved)
  const valid = !stat.isSymbolicLink() && stat.isDirectory() &&
    realCandidate === resolved && path.dirname(resolved) === realTmpRoot &&
    basename.startsWith(expectedPrefix) && basename.length > expectedPrefix.length
  if (!valid) throw new Error('mkdtemp returned an invalid disposable acceptance directory')
  return resolved
}

export async function loadCompetitivenessPolicy(repoRoot) {
  try {
    await execFile(
      'git',
      ['ls-files', '--error-unmatch', '--', COMPETITIVENESS_POLICY_RELATIVE_PATH],
      { cwd: repoRoot, encoding: 'utf8', maxBuffer: 1024 * 1024 },
    )
  } catch (error) {
    return null
  }
  try {
    // Read the policy from the exact checked-out commit, not from an ignored or
    // otherwise untracked worktree file. The SHA/clean preflight then proves
    // the approval policy was pre-existing and versioned in that release.
    const { stdout } = await execFile(
      'git',
      ['show', `HEAD:${COMPETITIVENESS_POLICY_RELATIVE_PATH}`],
      { cwd: repoRoot, encoding: 'utf8', maxBuffer: 1024 * 1024 },
    )
    return JSON.parse(stdout)
  } catch (error) {
    return { invalid: true, error: String(error?.message || error) }
  }
}

export async function verifySqliteMigrationCompleteness(db, repoRoot) {
  const migrationDir = path.join(repoRoot, 'backend/db/migrations')
  const expected = (await fs.readdir(migrationDir))
    .filter((name) => name.endsWith('.sql') || name.endsWith('.mjs'))
    .sort()
  const rows = await db.prepare('SELECT name FROM _migrations ORDER BY name').all()
  const applied = new Set((Array.isArray(rows) ? rows : []).map((row) => String(row?.name || '')).filter(Boolean))
  const missing = expected.filter((name) => !applied.has(name))
  return {
    ok: missing.length === 0,
    expected_count: expected.length,
    applied_count: applied.size,
    missing,
  }
}

export function evaluateCompetitivenessPolicy(policy, { fleetParity, cohortSize }) {
  if (!policy) {
    return {
      status: 'blocked',
      approved: false,
      reason: 'owner_approved_versioned_policy_missing',
      policy_path: COMPETITIVENESS_POLICY_RELATIVE_PATH,
    }
  }
  const approvedAt = Date.parse(policy.approved_at || '')
  const valid = policy.schema_version === POLICY_SCHEMA_VERSION &&
    typeof policy.policy_id === 'string' && policy.policy_id.trim() &&
    typeof policy.version === 'string' && policy.version.trim() &&
    policy.owner_approved === true &&
    policy.approved_by === POLICY_OWNER &&
    Number.isFinite(approvedAt) &&
    policy.metric === 'fleet_parity' &&
    policy.operator === 'gte' &&
    Number.isFinite(Number(policy.threshold)) &&
    Number(policy.threshold) >= 0 && Number(policy.threshold) <= 100 &&
    Number(policy.cohort_size) === Number(cohortSize)
  if (!valid) {
    return {
      status: 'blocked',
      approved: false,
      reason: policy.invalid ? 'policy_unreadable' : 'policy_invalid_or_unapproved',
      policy_path: COMPETITIVENESS_POLICY_RELATIVE_PATH,
    }
  }

  const threshold = Number(policy.threshold)
  const measured = Number(fleetParity)
  const meets = Number.isFinite(measured) && measured >= threshold
  return {
    status: meets ? 'passed' : 'failed',
    approved: true,
    reason: meets ? 'owner_approved_policy_satisfied' : 'owner_approved_policy_not_satisfied',
    policy_id: policy.policy_id,
    policy_version: policy.version,
    approved_by: policy.approved_by,
    approved_at: policy.approved_at,
    metric: policy.metric,
    operator: policy.operator,
    threshold,
    measured,
    cohort_size: Number(cohortSize),
  }
}

function provenanceEntry(results, index, query = null, threw = false) {
  const meta = results?.searchMeta && typeof results.searchMeta === 'object' ? results.searchMeta : null
  const resultCount = Array.isArray(results) ? results.length : 0
  return {
    query_index: index,
    query: query ? String(query).slice(0, 300) : null,
    result_count: resultCount,
    provider: String(meta?.provider || 'unknown'),
    provenance: String(meta?.provenance || 'unknown'),
    status: String(meta?.status || (threw ? 'error' : (resultCount > 0 ? 'ok' : 'empty'))),
    cache_age_ms: Number.isFinite(Number(meta?.cache_age_ms)) ? Number(meta.cache_age_ms) : null,
    provider_mode: meta?.provider_mode ?? null,
    reason: meta?.reason ?? null,
  }
}

function summarizeProvenance(perProfile, allowedProviders) {
  const allowed = new Set(uniqueStrings(allowedProviders).map((provider) => provider.toLowerCase()))
  const entries = []
  const profilesMissing = []
  for (const item of Array.isArray(perProfile) ? perProfile : []) {
    const profileId = String(item?.profile_id || '')
    const provenance = Array.isArray(item?.search_provenance) ? item.search_provenance : []
    if (provenance.length === 0) profilesMissing.push(profileId || null)
    for (const entry of provenance) entries.push({ profile_id: profileId || null, ...entry })
  }

  const providerCounts = {}
  const statusCounts = {}
  const violations = []
  for (const entry of entries) {
    const provider = String(entry?.provider || 'unknown').toLowerCase()
    const provenance = String(entry?.provenance || 'unknown').toLowerCase()
    const status = String(entry?.status || 'unknown').toLowerCase()
    providerCounts[provider] = (providerCounts[provider] || 0) + 1
    statusCounts[status] = (statusCounts[status] || 0) + 1
    const cache = provider === 'cache' || provenance === 'cache'
    const unknown = provider === 'unknown' || provenance === 'unknown' || status === 'unknown'
    const degraded = status.includes('degrad')
    const unavailable = ['error', 'unavailable', 'not_attempted'].includes(status)
    const unapproved = !allowed.has(provider)
    if (cache || unknown || degraded || unavailable || unapproved || provenance !== 'live') {
      violations.push({
        profile_id: entry.profile_id,
        query_index: entry.query_index ?? null,
        provider,
        provenance,
        status,
        classes: [
          ...(cache ? ['cache'] : []),
          ...(unknown ? ['unknown'] : []),
          ...(degraded ? ['degraded'] : []),
          ...(unavailable ? ['unavailable'] : []),
          ...(unapproved ? ['provider_not_approved'] : []),
          ...(provenance !== 'live' ? ['not_live'] : []),
        ],
      })
    }
  }
  return {
    allowed_providers: [...allowed],
    profiles_total: Array.isArray(perProfile) ? perProfile.length : 0,
    profiles_with_provenance: (Array.isArray(perProfile) ? perProfile.length : 0) - profilesMissing.length,
    profiles_missing_provenance: profilesMissing,
    queries_total: entries.length,
    provider_counts: providerCounts,
    status_counts: statusCounts,
    cache_queries: entries.filter((entry) => entry.provider === 'cache' || entry.provenance === 'cache').length,
    unknown_queries: violations.filter((entry) => entry.classes.includes('unknown')).length,
    degraded_queries: violations.filter((entry) => entry.classes.includes('degraded')).length,
    unavailable_queries: violations.filter((entry) => entry.classes.includes('unavailable')).length,
    violations: violations.slice(0, 100),
    ok: profilesMissing.length === 0 && entries.length > 0 && violations.length === 0,
  }
}

function amyEvidence(result, discoveryEvidence, allowedProviders) {
  const created = uniqueStrings(result?.created_profile_ids)
  const crawled = uniqueStrings(result?.crawled_profile_ids)
  const request = result?.combined?.cohort_request || {}
  const flywheel = result?.combined?.flywheel_cohort || null
  const flywheelReceipt = flywheel?.receipt || null
  const lanes = (Array.isArray(discoveryEvidence) ? discoveryEvidence : []).map((item) => {
    const lane = item?.web_lane || {}
    const searchProvenance = Array.isArray(lane.search_provenance) ? lane.search_provenance : []
    return {
      profile_id: item.profile_id,
      ok: lane.ok === true,
      queries_attempted: searchProvenance.length,
      pages: Number(lane.pages) || 0,
      fetched: Number(lane.fetched) || 0,
      extracted: Number(lane.extracted) || 0,
      stored: Number(lane.stored) || 0,
      rejected: Number(lane.rejected) || 0,
      search_provenance: searchProvenance,
    }
  })
  const provenance = summarizeProvenance(lanes, allowedProviders)
  const laneProfileIds = lanes.map((lane) => lane.profile_id)
  const laneTotals = lanes.reduce((totals, lane) => ({
    queries_attempted: totals.queries_attempted + lane.queries_attempted,
    pages: totals.pages + lane.pages,
    fetched: totals.fetched + lane.fetched,
    extracted: totals.extracted + lane.extracted,
    stored: totals.stored + lane.stored,
    rejected: totals.rejected + lane.rejected,
  }), { queries_attempted: 0, pages: 0, fetched: 0, extracted: 0, stored: 0, rejected: 0 })
  const laneReceiptComplete = lanes.length === ACCEPTANCE_TARGET &&
    uniqueStrings(laneProfileIds).length === ACCEPTANCE_TARGET &&
    sameMembers(laneProfileIds, created) && lanes.every((lane) => lane.ok)
  return {
    run_id: result?.run_id ?? null,
    requested: Number(request?.requested_target ?? 0),
    planned: Number(request?.planned_members ?? 0),
    exact_plan: request?.exact_plan === true,
    created: created.length,
    crawled: crawled.length,
    created_profile_ids: created,
    crawled_profile_ids: crawled,
    created_crawled_membership_equal: sameMembers(created, crawled),
    flywheel: flywheelReceipt,
    flywheel_complete: flywheelReceipt?.complete === true,
    flywheel_all_clean: flywheelReceipt?.all_clean === true,
    flywheel_membership_isolated: flywheelReceipt?.membership_isolated === true,
    web_lane_receipts: lanes.map((lane) => ({
      profile_id: lane.profile_id,
      ok: lane.ok,
      queries_attempted: lane.queries_attempted,
      pages: lane.pages,
      fetched: lane.fetched,
      extracted: lane.extracted,
      stored: lane.stored,
      rejected: lane.rejected,
    })),
    web_lane_receipts_complete: laneReceiptComplete,
    web_lane_totals: laneTotals,
    provenance,
    summary: result?.summary ?? null,
    qualification_proven: false,
    limitation: 'Amy is a bounded synthetic regression cohort. A clean receipt does not prove applicant eligibility, qualification, submission, or an award.',
  }
}

function parityEvidence(result, expectedIds, allowedProviders) {
  const rows = Array.isArray(result?.per_profile) ? result.per_profile : []
  const ids = rows.map((row) => String(row?.profile_id || '')).filter(Boolean)
  const provenance = summarizeProvenance(rows, allowedProviders)
  return {
    ran: result?.ran === true,
    measurement_status: result?.measurement_status ?? null,
    fleet_parity: Number.isFinite(Number(result?.fleet_parity)) ? Number(result.fleet_parity) : null,
    profiles_total: Number(result?.profiles_total ?? rows.length),
    profiles_scored: Number(result?.profiles_scored ?? 0),
    profiles_unscored: Number(result?.profiles_unscored ?? 0),
    exact_membership: ids.length === ACCEPTANCE_TARGET && uniqueStrings(ids).length === ACCEPTANCE_TARGET && sameMembers(ids, expectedIds),
    profile_ids: ids,
    per_profile: rows.map((row) => ({
      profile_id: row.profile_id,
      parity: row.parity ?? null,
      measurement_status: row.measurement_status ?? null,
      error: row.error ?? null,
      overlap_count: row.overlap_count ?? null,
      web_only_count: row.web_only_count ?? null,
      queries_run: row.queries_run ?? null,
      search_provider_counts: row.search_provider_counts ?? null,
    })),
    provenance,
    persist: false,
    qualification_proven: false,
    limitation: 'Web parity measures source discovery overlap for this exact synthetic cohort; it does not prove eligibility, qualification, submission, or award likelihood.',
  }
}

function noOpMesh() {
  return {
    consumeInbox: async () => [],
    readLessons: async () => [],
    recordLesson: async () => ({ id: null, topic: null, claim: null }),
    postMessage: async () => null,
    markConsumed: async () => null,
  }
}

function amyPasses(amy) {
  return amy.requested === ACCEPTANCE_TARGET && amy.planned === ACCEPTANCE_TARGET && amy.exact_plan &&
    amy.created === ACCEPTANCE_TARGET && amy.crawled === ACCEPTANCE_TARGET &&
    amy.created_crawled_membership_equal && amy.flywheel_complete && amy.flywheel_all_clean &&
    amy.flywheel_membership_isolated && amy.flywheel?.requested_target === ACCEPTANCE_TARGET &&
    amy.flywheel?.planned_members === ACCEPTANCE_TARGET && amy.flywheel?.evaluation_rows === ACCEPTANCE_TARGET &&
    amy.web_lane_receipts_complete && amy.web_lane_totals.queries_attempted > 0 &&
    amy.web_lane_totals.fetched > 0 && amy.web_lane_totals.extracted > 0 &&
    amy.provenance.profiles_total === ACCEPTANCE_TARGET &&
    amy.provenance.profiles_with_provenance === ACCEPTANCE_TARGET && amy.provenance.ok
}

function parityPasses(parity) {
  return parity.ran && parity.measurement_status === 'scored' &&
    parity.profiles_total === ACCEPTANCE_TARGET && parity.profiles_scored === ACCEPTANCE_TARGET &&
    parity.profiles_unscored === 0 && parity.exact_membership && Number.isFinite(parity.fleet_parity) &&
    parity.provenance.profiles_total === ACCEPTANCE_TARGET &&
    parity.provenance.profiles_with_provenance === ACCEPTANCE_TARGET && parity.provenance.ok
}

function buildReceipt({ expectedSha, outputPath, allowedProviders, nodeVersion, now }) {
  return {
    schema_version: ACCEPTANCE_SCHEMA_VERSION,
    acceptance_id: crypto.randomUUID(),
    status: 'running',
    exit_code: null,
    started_at: now().toISOString(),
    completed_at: null,
    source: { expected_sha: expectedSha, observed_sha: null, worktree_clean: null },
    operator: {
      target: ACCEPTANCE_TARGET,
      output: outputPath,
      allowed_providers: allowedProviders,
      node_version: nodeVersion,
    },
    isolation: {
      database: 'fresh_temporary_sqlite',
      migrations: 'strict',
      server_started: false,
      schedulers_started: false,
      cache_disabled: true,
      production_database_used: false,
      outbound_email_enabled: false,
      temp_directory_deleted: null,
    },
    amy: null,
    web_parity: null,
    competitiveness: null,
    cleanup: null,
    checks: [],
    error: null,
    qualification_proven: false,
    limitations: [
      'Synthetic cohort results do not prove eligibility, qualification, submission, or awards.',
      'Web parity is not called materially competitive without an owner-approved, versioned policy.',
    ],
  }
}

/**
 * Run acceptance. Every operational dependency is injectable so unit tests can
 * exercise fail-closed behavior without providers, migrations, or a real DB.
 */
export async function runAmyWebParityAcceptance(options = {}) {
  const {
    repoRoot = process.cwd(),
    expectedSha,
    output,
    allowedProviders = DEFAULT_ALLOWED_PROVIDERS,
    env = process.env,
    nodeVersion = process.versions.node,
    now = () => new Date(),
    inspectSource = inspectGitSource,
    makeTempDir = (prefix) => fs.mkdtemp(prefix),
    runMigrations = runStrictMigrations,
    loadRuntime = loadDefaultAcceptanceRuntime,
    verifyMigrations = verifySqliteMigrationCompleteness,
    preflightDependencies = runDependencyPreflight,
    loadPolicy = loadCompetitivenessPolicy,
    writeReceipt = writeAtomicReceipt,
  } = options

  const normalizedProviders = uniqueStrings(allowedProviders).map((provider) => provider.toLowerCase())
  let controlledOutput = null
  let receipt = buildReceipt({ expectedSha, outputPath: output, allowedProviders: normalizedProviders, nodeVersion, now })
  let exitCode = ACCEPTANCE_EXIT.PASS
  let failure = null
  let tempDir = null
  let runtime = null
  let db = null
  let disposableDbVerified = false
  let restoreEnvironment = null
  let amyRunId = `acceptance-amy-${crypto.randomUUID()}`
  let createdIds = []
  let crawledIds = []

  try {
    // This is lexical validation only: a clean checkout does not contain the
    // ignored audit-reports directory, and no artifact/directory may be
    // created before the exact SHA + clean-worktree checks complete.
    controlledOutput = resolveControlledOutputCandidate(repoRoot, output)
  } catch (error) {
    receipt.status = 'failed'
    receipt.exit_code = ACCEPTANCE_EXIT.RECEIPT_WRITE
    receipt.completed_at = now().toISOString()
    receipt.error = safeError(error)
    return { receipt, exitCode: ACCEPTANCE_EXIT.RECEIPT_WRITE, outputPath: null }
  }

  try {
    const source = await inspectSource(repoRoot)
    receipt.source.observed_sha = source?.sha ?? null
    receipt.source.worktree_clean = String(source?.status || '').trim() === ''
    addCheck(receipt, 'source.expected_sha_matches_head', String(source?.sha || '').toLowerCase() === String(expectedSha || '').toLowerCase(), {
      expected: expectedSha,
      observed: source?.sha ?? null,
    })
    addCheck(receipt, 'source.worktree_clean', receipt.source.worktree_clean)

    if (!SHA_RE.test(String(expectedSha || ''))) {
      fail('--expected-sha must be an exact 40-character Git SHA', 'preflight', ACCEPTANCE_EXIT.PREFLIGHT)
    }
    if (String(nodeVersion) !== ACCEPTANCE_NODE_VERSION) {
      fail(
        `Node ${ACCEPTANCE_NODE_VERSION} is required (received ${nodeVersion})`,
        'preflight',
        ACCEPTANCE_EXIT.PREFLIGHT,
      )
    }
    if (normalizedProviders.length === 0) {
      fail('at least one approved live provider is required', 'preflight', ACCEPTANCE_EXIT.PREFLIGHT)
    }
    const unknownAllowedProviders = normalizedProviders.filter(
      (provider) => !DEFAULT_ALLOWED_PROVIDERS.includes(provider),
    )
    if (unknownAllowedProviders.length > 0) {
      fail(
        `--allowed-providers contains unknown provider(s): ${unknownAllowedProviders.join(', ')}`,
        'preflight',
        ACCEPTANCE_EXIT.PREFLIGHT,
      )
    }

    addCheck(receipt, 'runtime.node', true, { node_version: nodeVersion })
    if (String(source?.sha || '').toLowerCase() !== String(expectedSha).toLowerCase()) {
      fail('expected SHA does not match checked-out HEAD', 'preflight', ACCEPTANCE_EXIT.PREFLIGHT)
    }
    if (!receipt.source.worktree_clean) {
      fail('worktree is not clean', 'preflight', ACCEPTANCE_EXIT.PREFLIGHT)
    }

    // No output or temporary artifact is created before the SHA/clean checks.
    const tempCandidate = await makeTempDir(path.join(os.tmpdir(), 'grantflow-amy-parity-'))
    tempDir = await validateDisposableTempDirectory(tempCandidate)
    const sqlitePath = path.join(tempDir, 'acceptance.sqlite')
    const hermetic = installHermeticEnvironment(env, sqlitePath)
    restoreEnvironment = hermetic.restore
    receipt.isolation.scrubbed_environment_key_count = hermetic.scrubbed_keys.length

    const migrationResult = await runMigrations({ repoRoot, env, sqlitePath })
    addCheck(receipt, 'isolation.strict_migrations', migrationResult?.ok !== false)
    if (migrationResult?.ok === false) {
      fail('strict SQLite migrations did not complete', 'migrations', ACCEPTANCE_EXIT.RUNTIME)
    }

    runtime = await loadRuntime(repoRoot, { env, sqlitePath })
    db = runtime?.db
    const requiredFunctions = [
      'runAmyTraining', 'runWebParityBenchmark', 'runProfileDiscoveryLive',
      'cleanupAmyProfiles', 'listAmyProfiles', 'countAmyProfiles', 'verifyAmyDeletion',
      'searchWeb', 'extractOpportunitiesFromPage',
    ]
    const missing = requiredFunctions.filter((name) => typeof runtime?.[name] !== 'function')
    if (!db?.prepare || missing.length > 0) {
      fail(`acceptance runtime is incomplete${missing.length ? `: ${missing.join(', ')}` : ''}`, 'runtime', ACCEPTANCE_EXIT.RUNTIME)
    }
    const exactDisposableDb = db.dialect === 'sqlite' &&
      typeof db.path === 'string' && path.resolve(db.path) === path.resolve(sqlitePath)
    receipt.isolation.database_path_verified = exactDisposableDb
    addCheck(receipt, 'isolation.exact_temporary_sqlite_connection', exactDisposableDb, {
      dialect: db.dialect ?? null,
      path_matches_disposable_target: exactDisposableDb,
    })
    if (!exactDisposableDb) {
      fail('runtime did not open the exact disposable SQLite database', 'runtime', ACCEPTANCE_EXIT.RUNTIME)
    }
    disposableDbVerified = true
    const migrationProof = await verifyMigrations(db, repoRoot)
    receipt.isolation.migration_proof = migrationProof
    addCheck(receipt, 'isolation.all_sqlite_migrations_recorded', migrationProof?.ok === true, migrationProof)
    if (migrationProof?.ok !== true) {
      fail('disposable SQLite migration ledger is incomplete', 'migrations', ACCEPTANCE_EXIT.RUNTIME)
    }

    let dependencyProof = null
    try {
      dependencyProof = await preflightDependencies({
        env,
        allowedProviders: normalizedProviders,
        searchWeb: runtime.searchWeb,
        extractOpportunitiesFromPage: runtime.extractOpportunitiesFromPage,
      })
    } catch {
      // Never preserve an underlying provider error message here: SDK errors
      // can contain request metadata. The receipt records only this safe code.
      dependencyProof = {
        ok: false,
        search: { reason: 'dependency_preflight_threw' },
        extractor: { reason: 'dependency_preflight_threw' },
      }
    }
    receipt.isolation.dependency_preflight = dependencyProof
    addCheck(receipt, 'isolation.live_search_and_extractor_preflight', dependencyProof?.ok === true, dependencyProof)
    if (dependencyProof?.ok !== true) {
      fail('live search/extractor dependency preflight failed', 'dependency_preflight', ACCEPTANCE_EXIT.RUNTIME)
    }

    const discoveryEvidence = []
    const trackedDiscovery = async (args) => {
      try {
        const result = await runtime.runProfileDiscoveryLive(args)
        discoveryEvidence.push({
          profile_id: String(args?.profileId || ''),
          web_lane: result?.run?.web_lane ?? null,
        })
        return result
      } catch (error) {
        discoveryEvidence.push({
          profile_id: String(args?.profileId || ''),
          web_lane: { ok: false, search_provenance: [provenanceEntry([], 0, null, true)] },
        })
        throw error
      }
    }

    let amyResult = null
    try {
      amyResult = await runtime.runAmyTraining({
        db,
        runId: amyRunId,
        targetCount: ACCEPTANCE_TARGET,
        dryRunDiscovery: false,
        keepProfiles: true,
        improve: false,
        applyTuning: false,
        applyWeights: false,
        applyCoverage: false,
        applyLearning: false,
        anyaEnabled: false,
        anyaApply: false,
        samEnabled: false,
        samApply: false,
        gapLearning: false,
        saveReport: false,
        writeArtifact: null,
        runDiscovery: trackedDiscovery,
        recordActivity: async () => null,
        mesh: noOpMesh(),
      })
      amyRunId = amyResult?.run_id || amyRunId
      createdIds = uniqueStrings(amyResult?.created_profile_ids)
      crawledIds = uniqueStrings(amyResult?.crawled_profile_ids)
      receipt.amy = amyEvidence(amyResult, discoveryEvidence, normalizedProviders)
      const ok = amyPasses(receipt.amy)
      addCheck(receipt, 'amy.exact_50_complete_clean_isolated', ok, {
        requested: receipt.amy.requested,
        planned: receipt.amy.planned,
        created: receipt.amy.created,
        crawled: receipt.amy.crawled,
        flywheel_complete: receipt.amy.flywheel_complete,
        flywheel_all_clean: receipt.amy.flywheel_all_clean,
        web_lane_receipts_complete: receipt.amy.web_lane_receipts_complete,
        web_lane_totals: receipt.amy.web_lane_totals,
      })
      addCheck(receipt, 'amy.live_provider_provenance', receipt.amy.provenance.ok, receipt.amy.provenance)
      if (!ok && exitCode === ACCEPTANCE_EXIT.PASS) exitCode = ACCEPTANCE_EXIT.AMY
    } catch (error) {
      failure = new AcceptanceFailure(`Amy acceptance run failed: ${error?.message || error}`, {
        stage: 'amy',
        exitCode: ACCEPTANCE_EXIT.AMY,
      })
      exitCode = ACCEPTANCE_EXIT.AMY
      receipt.amy = {
        run_id: amyRunId,
        created_profile_ids: createdIds,
        crawled_profile_ids: crawledIds,
        partial: true,
        error: safeError(error),
        qualification_proven: false,
      }
    }

    if (amyResult) {
      const exactGolden = createdIds.map((profileId, index) => ({
        profile_id: profileId,
        label: `Amy acceptance member ${index + 1}`,
        require_sources: [],
      }))
      let loadGoldenCalls = 0
      const loadGolden = async () => {
        loadGoldenCalls += 1
        return exactGolden.map((entry) => ({ ...entry }))
      }
      try {
        const parityResult = await runtime.runWebParityBenchmark(db, {
          profileIds: createdIds,
          loadGolden,
          persist: false,
          emitTelemetry: async () => null,
          now: now(),
        })
        receipt.web_parity = parityEvidence(parityResult, createdIds, normalizedProviders)
        receipt.web_parity.load_golden_calls = loadGoldenCalls
        receipt.web_parity.injected_golden_membership = exactGolden.map((entry) => entry.profile_id)
        const parityOk = loadGoldenCalls > 0 && parityPasses(receipt.web_parity)
        addCheck(receipt, 'web_parity.exact_50_scored_same_membership', parityOk, {
          profiles_total: receipt.web_parity.profiles_total,
          profiles_scored: receipt.web_parity.profiles_scored,
          profiles_unscored: receipt.web_parity.profiles_unscored,
          exact_membership: receipt.web_parity.exact_membership,
          load_golden_calls: loadGoldenCalls,
        })
        addCheck(receipt, 'web_parity.live_provider_provenance', receipt.web_parity.provenance.ok, receipt.web_parity.provenance)
        if (!parityOk && exitCode === ACCEPTANCE_EXIT.PASS) exitCode = ACCEPTANCE_EXIT.PARITY
      } catch (error) {
        if (!failure) failure = new AcceptanceFailure(`web parity run failed: ${error?.message || error}`, {
          stage: 'web_parity',
          exitCode: ACCEPTANCE_EXIT.PARITY,
        })
        if (exitCode === ACCEPTANCE_EXIT.PASS) exitCode = ACCEPTANCE_EXIT.PARITY
        receipt.web_parity = { partial: true, error: safeError(error), qualification_proven: false }
      }
    }

    const policy = await loadPolicy(repoRoot)
    receipt.competitiveness = evaluateCompetitivenessPolicy(policy, {
      fleetParity: receipt.web_parity?.fleet_parity,
      cohortSize: ACCEPTANCE_TARGET,
    })
    const policyOk = receipt.competitiveness.status === 'passed'
    addCheck(receipt, 'web_parity.owner_approved_competitiveness_policy', policyOk, receipt.competitiveness)
    if (!policyOk && exitCode === ACCEPTANCE_EXIT.PASS) {
      exitCode = receipt.competitiveness.status === 'blocked'
        ? ACCEPTANCE_EXIT.POLICY_BLOCKED
        : ACCEPTANCE_EXIT.PARITY
    }
  } catch (error) {
    failure = error instanceof AcceptanceFailure
      ? error
      : new AcceptanceFailure(String(error?.message || error), { stage: 'runtime', exitCode: ACCEPTANCE_EXIT.RUNTIME })
    exitCode = failure.exitCode
  } finally {
    if (runtime && db && disposableDbVerified) {
      let strictCleanup = null
      let recoveryCleanup = null
      let proof = null
      let runSurvivors = null
      try {
        const before = await runtime.countAmyProfiles(db)
        strictCleanup = await runtime.cleanupAmyProfiles(db, {
          runId: amyRunId,
          onlyIds: crawledIds,
          requireCrawled: true,
          force: true,
          now: now(),
        })
        // If Amy threw before returning its crawled-id list, the disposable DB
        // can still contain this run's guarded synthetic rows. The same
        // canonical cleaner removes only this acceptance run's Amy markers.
        recoveryCleanup = await runtime.cleanupAmyProfiles(db, {
          runId: amyRunId,
          requireCrawled: false,
          force: true,
          now: now(),
        })
        proof = await runtime.verifyAmyDeletion(db, {
          before,
          runCleanup: strictCleanup,
          expiredSweep: recoveryCleanup,
          created: createdIds.length,
          now: now(),
        })
        const remaining = await runtime.listAmyProfiles(db)
        runSurvivors = (Array.isArray(remaining) ? remaining : []).filter(
          (profile) => String(profile?.metadata?.amy_run_id || '') === String(amyRunId),
        )
        const cleanupOk = proof?.verdict === 'proven' && Number(proof?.profiles_after) === 0 && runSurvivors.length === 0
        receipt.cleanup = {
          strict: strictCleanup,
          recovery: recoveryCleanup,
          proof,
          acceptance_run_survivors: runSurvivors.map((profile) => profile.id),
          ok: cleanupOk,
        }
        addCheck(receipt, 'cleanup.canonical_deletion_proven', cleanupOk, receipt.cleanup)
        if (!cleanupOk) exitCode = ACCEPTANCE_EXIT.CLEANUP
      } catch (error) {
        receipt.cleanup = {
          strict: strictCleanup,
          recovery: recoveryCleanup,
          proof,
          acceptance_run_survivors: runSurvivors,
          ok: false,
          error: safeError(error),
        }
        addCheck(receipt, 'cleanup.canonical_deletion_proven', false, receipt.cleanup)
        exitCode = ACCEPTANCE_EXIT.CLEANUP
        if (!failure) failure = new AcceptanceFailure('acceptance cleanup failed', {
          stage: 'cleanup',
          exitCode: ACCEPTANCE_EXIT.CLEANUP,
        })
      }
      try {
        await db.close?.()
      } catch (error) {
        receipt.cleanup = { ...(receipt.cleanup || {}), db_close_error: safeError(error), ok: false }
        exitCode = ACCEPTANCE_EXIT.CLEANUP
      }
    } else if (db) {
      // A connection that is not proven to be the exact disposable SQLite
      // target must never receive even the guarded Amy cleanup statements.
      receipt.cleanup = { ok: false, skipped: true, reason: 'database_not_proven_disposable' }
      try { await db.close?.() } catch { /* isolated CLI process; no mutation fallback */ }
    }

    if (restoreEnvironment) restoreEnvironment()
    if (tempDir) {
      try {
        const revalidatedTemp = await validateDisposableTempDirectory(tempDir)
        await fs.rm(revalidatedTemp, { recursive: true, force: true })
        receipt.isolation.temp_directory_deleted = true
      } catch (error) {
        receipt.isolation.temp_directory_deleted = false
        receipt.isolation.temp_delete_error = safeError(error)
        exitCode = ACCEPTANCE_EXIT.CLEANUP
      }
    } else {
      receipt.isolation.temp_directory_deleted = null
    }
  }

  receipt.completed_at = now().toISOString()
  receipt.exit_code = exitCode
  receipt.status = exitCode === ACCEPTANCE_EXIT.PASS
    ? 'passed'
    : (exitCode === ACCEPTANCE_EXIT.POLICY_BLOCKED ? 'blocked' : 'failed')
  if (failure) receipt.error = safeError(failure)

  try {
    await writeReceipt(repoRoot, controlledOutput, receipt)
  } catch (error) {
    receipt.status = 'failed'
    receipt.exit_code = ACCEPTANCE_EXIT.RECEIPT_WRITE
    receipt.error = safeError(error)
    return { receipt, exitCode: ACCEPTANCE_EXIT.RECEIPT_WRITE, outputPath: null }
  }
  return { receipt, exitCode, outputPath: controlledOutput }
}

export default {
  ACCEPTANCE_TARGET,
  ACCEPTANCE_SCHEMA_VERSION,
  ACCEPTANCE_EXIT,
  DEFAULT_ALLOWED_PROVIDERS,
  resolveControlledOutputPath,
  writeAtomicReceipt,
  installHermeticEnvironment,
  runDependencyPreflight,
  validateDisposableTempDirectory,
  evaluateCompetitivenessPolicy,
  runAmyWebParityAcceptance,
}
