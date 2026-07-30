#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const truthy = (value) => /^(1|true|yes|on)$/i.test(String(value || '').trim())
if (truthy(process.env.GRANTFLOW_SKIP_SOURCE_MATERIALIZATION)) {
  console.log('[source-materialization] skipped by GRANTFLOW_SKIP_SOURCE_MATERIALIZATION')
  process.exit(0)
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(repoRoot)

const coreSignatures = Object.freeze([
  ['backend/services/missionHealthService.js', 'export function normalizeCount'],
  ['backend/services/missionHealthService.js', 'verification_events WHERE ts >= ?'],
  ['backend/routes/ai.js', 'fetchPublicText(portal_url'],
  ['backend/start.js', 'Schema migrations have exactly one owner'],
  ['backend/routes/health.js', "reason: 'mission_gate_failed'"],
  ['backend/server.js', 'ensureRuntimeSecretKeyMaterial'],
  ['backend/services/linkVerificationService.js', 'stats.quarantined'],
  ['backend/services/linkVerificationService.js', 'proof-based startup quarantine'],
  ['scripts/check-deployment-config.mjs', 'hasProductionHostGuard'],
  ['src/config/env.js', 'VITE_PREVIEW_API_URL'],
])
const linkBacklogSignatures = Object.freeze([
  ['backend/services/crawlers/nationalZipCrawler.js', 'link_backlog_resource_contract'],
  ['backend/services/linkVerificationService.js', 'browser-compatible liveness probe'],
  ['backend/services/linkVerificationService.js', 'link_repair_success_restores_visibility'],
  ['backend/server.js', "app.use('/api/admin/link-repair'"],
  ['backend/server.js', '[link-repair] recurring lifecycle pass'],
  ['backend/services/missionHealthService.js', 'repair_pending_broken_direct_opportunities'],
  ['backend/services/linkBacklogRepairService.js', 'export async function repairBrokenDirectBatch'],
  ['backend/services/linkBacklogRepairService.js', 'link_backlog_selected_row_claim'],
  ['backend/services/linkBacklogRepairService.js', 'link_backlog_row_error_isolation'],
  ['backend/services/linkBacklogRepairService.js', 'export function estimateRepairLockTtlMs'],
  ['backend/services/linkBacklogRepairService.js', 'official_rescue_clears_unprobeable_urls'],
  ['backend/routes/linkBacklogRepair.js', 'link_backlog_shared_scheduler_lock'],
  ['backend/routes/linkBacklogRepair.js', 'link_backlog_runtime_bounded_lock_ttl'],
  ['backend/tests/linkBacklogRepairService.test.js', 'link_backlog_extended_url_fixture'],
  ['backend/tests/linkBacklogSafetyRegression.test.js', 'official-only rescue clears unprobeable URL fields'],
  ['backend/tests/linkBacklogSafetyRegression.test.js', 'sizes the shared lock lease for the bounded worst case'],
])
const webParitySignatures = Object.freeze([
  ['backend/services/webParityBenchmark.js', 'export function isBenchmarkRelevantHit'],
  ['backend/services/webParityBenchmark.js', 'export function isGenericFundingPortalHit'],
  ['backend/services/webParityBenchmark.js', 'export function isBenchmarkDirectFundingHit'],
  ['backend/services/webParityBenchmark.js', 'if (!covers && !isBenchmarkDirectFundingHit'],
  ['backend/services/webParityBenchmark.js', 'function isTerminalGapStatus'],
  ['backend/services/webParityBenchmark.js', 'const WEB_ONLY_TOP_CAP = 20'],
  ['backend/server.js', "app.use('/api/admin/web-parity'"],
  ['backend/routes/webParityAdmin.js', 'function launchParityRun'],
])
const amySignatures = Object.freeze([
  ['backend/services/amy/amyAgent.js', "boundedAmyPreflight('mesh_context'"],
  ['backend/services/amy/amyAgent.js', "'fleet_gap_scoreboard'"],
  ['backend/services/amy/amyRunner.js', 'export async function recoverStaleAmyRunLock'],
  ['backend/services/amy/amyRunner.js', 'AMY_SCHEDULER_LOCK_NAME'],
  ['backend/routes/amy.js', "router.post('/recover-stale-run-lock'"],
])
const signatures = Object.freeze([
  ...coreSignatures,
  ...linkBacklogSignatures,
  ...webParitySignatures,
  ...amySignatures,
])

const hasSignature = ([file, signature]) => {
  try {
    return fs.readFileSync(file, 'utf8').includes(signature)
  } catch {
    return false
  }
}

function hasResourcePreservation() {
  try {
    const source = fs.readFileSync('backend/services/crawlerOsPersistence.js', 'utf8')
    const inlineImplementation =
      source.includes('const deleteStaleDirectMatches = db.prepare') &&
      source.includes('const deleteExplicitReject = db.prepare')
    const needFirstFacade =
      source.includes('async function snapshotResourceMatches') &&
      source.includes('async function restoreResourceMatches') &&
      source.includes('resourcesPreserved')
    return inlineImplementation || needFirstFacade
  } catch {
    return false
  }
}

async function applyModule(modulePath, label = modulePath) {
  await import(`${pathToFileURL(path.resolve(modulePath)).href}?materialize=${Date.now()}`)
  console.log(`[source-materialization] applied ${label}`)
}

async function applyLinkBacklogCorrections() {
  await applyModule(
    'scripts/source-materialization/apply-link-backlog-resolution.mjs',
    'link backlog lifecycle correction',
  )
  await applyModule(
    'scripts/source-materialization/apply-link-backlog-candidate-selection.mjs',
    'link backlog candidate selection',
  )
  await applyModule(
    'scripts/source-materialization/apply-link-backlog-row-isolation.mjs',
    'link backlog row isolation',
  )
  await applyModule(
    'scripts/source-materialization/apply-link-verification-success-restore.mjs',
    'link verification success restore',
  )
  await applyModule(
    'scripts/source-materialization/apply-link-backlog-route-lock.mjs',
    'link backlog route lock',
  )
  await applyModule(
    'scripts/source-materialization/apply-link-backlog-final-safety.mjs',
    'link backlog final rescue and lock safety',
  )
}

async function applyWebParityCorrections() {
  await applyModule(
    'scripts/source-materialization/apply-web-parity-source-quality-prelude.mjs',
    'web-parity source-quality prelude',
  )
  await applyModule(
    'scripts/source-materialization/apply-web-parity-relevance.mjs',
    'web-parity relevance and queue correction',
  )
  await applyModule(
    'scripts/source-materialization/apply-web-parity-source-quality-finalize.mjs',
    'web-parity direct-source finalization',
  )
  await applyModule(
    'scripts/source-materialization/apply-web-parity-admin-route.mjs',
    'web-parity background admin route',
  )
}

async function applyAmyCorrections() {
  await applyModule(
    'scripts/source-materialization/apply-amy-preflight-watchdog.mjs',
    'Amy preflight watchdog',
  )
}

async function refreshEnvExamples() {
  const generatorPath = path.resolve('scripts/generate-env-examples.mjs')
  const { buildOutputs } = await import(
    `${pathToFileURL(generatorPath).href}?materialize-env=${Date.now()}`
  )
  const { rootEnvExample, backendEnvExample } = buildOutputs()
  fs.writeFileSync(path.resolve('.env.example'), rootEnvExample)
  fs.mkdirSync(path.resolve('backend'), { recursive: true })
  fs.writeFileSync(path.resolve('backend/.env.example'), backendEnvExample)
  console.log('[source-materialization] regenerated env examples from the materialized source tree')
}

const corePresent = coreSignatures.filter(hasSignature)
if (corePresent.length === coreSignatures.length && hasResourcePreservation()) {
  // Apply every later product correction idempotently before the read-only exit.
  // This ordering prevents one independently verified repair from erasing another.
  await applyLinkBacklogCorrections()
  await applyWebParityCorrections()
  await applyAmyCorrections()
  const missingIncremental = [
    ...linkBacklogSignatures,
    ...webParitySignatures,
    ...amySignatures,
  ].filter((entry) => !hasSignature(entry))
  if (missingIncremental.length > 0) {
    throw new Error(
      `[source-materialization] incremental signatures missing: ${missingIncremental.map(([, signature]) => signature).join(', ')}`,
    )
  }
  // Repeated npm prehooks run concurrently in the unit suite and must remain
  // read-only once every signature is present.
  console.log('[source-materialization] verified product source already present')
  process.exit(0)
}
if (corePresent.length > 0) {
  throw new Error(
    `[source-materialization] partial source tree detected: ${corePresent.map(([file]) => file).join(', ')}`,
  )
}

const modules = [
  'scripts/source-materialization/prepare.mjs',
  'scripts/source-materialization/apply-code.mjs',
  'scripts/source-materialization/apply-verification-events-metric.mjs',
  'scripts/source-materialization/apply-resource-reconciliation.mjs',
  'scripts/source-materialization/apply-proof-based-quarantine.mjs',
  'scripts/source-materialization/apply-readiness-deployment.mjs',
  'scripts/source-materialization/apply-runtime-secret-wiring.mjs',
  'scripts/source-materialization/apply-test-updates.mjs',
]

for (const modulePath of modules) {
  await applyModule(modulePath)
}
await applyLinkBacklogCorrections()
await applyWebParityCorrections()
await applyAmyCorrections()

const missing = signatures.filter((entry) => !hasSignature(entry))
if (missing.length > 0) {
  throw new Error(
    `[source-materialization] final signatures missing: ${missing.map(([file, signature]) => `${file}:${signature}`).join(', ')}`,
  )
}
if (!hasResourcePreservation()) {
  throw new Error('[source-materialization] resource-preserving reconciliation is missing')
}

await refreshEnvExamples()

// The generator inputs are permanent source-build infrastructure, not runtime
// files. Keep them available through env-contract and release verification.
// Vercel publishes only dist/, and the production Docker runtime stage copies
// only materialized backend/shared/config assets, so these inputs never ship.
console.log('[source-materialization] verified product source materialized; generator inputs retained for verification only')
