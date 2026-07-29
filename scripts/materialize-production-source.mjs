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

const signatures = Object.freeze([
  ['backend/services/missionHealthService.js', 'export function normalizeCount'],
  ['backend/routes/ai.js', 'fetchPublicText(portal_url'],
  ['backend/start.js', 'Schema migrations have exactly one owner'],
  ['backend/routes/health.js', "reason: 'mission_gate_failed'"],
  ['backend/server.js', 'ensureRuntimeSecretKeyMaterial'],
  ['backend/services/crawlerOsPersistence.js', 'const deleteStaleDirectMatches'],
  ['backend/services/linkVerificationService.js', 'stats.quarantined'],
  ['scripts/check-deployment-config.mjs', 'hasProductionHostGuard'],
  ['src/config/env.js', 'VITE_PREVIEW_API_URL'],
])

const hasSignature = ([file, signature]) => {
  try {
    return fs.readFileSync(file, 'utf8').includes(signature)
  } catch {
    return false
  }
}

const present = signatures.filter(hasSignature)
if (present.length === signatures.length) {
  console.log('[source-materialization] verified product source already present')
  process.exit(0)
}
if (present.length > 0) {
  throw new Error(
    `[source-materialization] partial source tree detected: ${present.map(([file]) => file).join(', ')}`,
  )
}

const modules = [
  'scripts/source-materialization/prepare.mjs',
  'scripts/source-materialization/apply-code.mjs',
  'scripts/source-materialization/apply-resource-reconciliation.mjs',
  'scripts/source-materialization/apply-readiness-deployment.mjs',
  'scripts/source-materialization/apply-runtime-secret-wiring.mjs',
  'scripts/source-materialization/apply-test-updates.mjs',
  'scripts/generate-env-examples.mjs',
]

for (const modulePath of modules) {
  await import(`${pathToFileURL(path.resolve(modulePath)).href}?materialize=${Date.now()}`)
}

const missing = signatures.filter((entry) => !hasSignature(entry))
if (missing.length > 0) {
  throw new Error(
    `[source-materialization] final signatures missing: ${missing.map(([file]) => file).join(', ')}`,
  )
}

// The generator inputs are permanent source-build infrastructure, not runtime
// files. Keep them available through env-contract and release verification.
// Vercel publishes only dist/, and the production Docker runtime stage copies
// only materialized backend/shared/config assets, so these inputs never ship.
console.log('[source-materialization] verified product source materialized; generator inputs retained for verification only')
