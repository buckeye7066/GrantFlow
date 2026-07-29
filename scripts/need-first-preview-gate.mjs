import { spawnSync } from 'node:child_process'

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function run(args, label) {
  console.log(`[need-first-preview-gate] ${label}`)
  const result = spawnSync(npm, args, {
    stdio: 'inherit',
    env: process.env,
    shell: false,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit ${result.status}`)
  }
}

run([
  'exec', '--', 'vitest', 'run',
  'backend/tests/needFirstMatchPolicy.test.js',
  'backend/tests/needFirstPolicyEdgeCases.test.js',
  'backend/tests/needFirstProductionExamples.test.js',
  'backend/tests/persistedMatchTruth.test.js',
  'backend/tests/persistedNeedFirstEdgeCases.test.js',
  'backend/tests/remainingAuditCorrections.test.js',
  'backend/tests/fundingSourceCounts.test.js',
  '--reporter=verbose',
], 'focused Vitest regressions')

run(['exec', '--', 'node', 'scripts/need-first-build-self-test.mjs'], 'backend integration assertions')
run(['run', 'check:prepush'], 'pre-push quality suite')
run(['run', 'scan:secrets'], 'secret scan')
run(['audit', '--omit=dev', '--audit-level=high'], 'production dependency audit')
run(['run', 'release:gates'], 'complete release gates')
run(['run', 'build'], 'production Vite build')

console.log('[need-first-preview-gate] PASS')
