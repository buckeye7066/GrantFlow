/**
 * Release gates runner (single command).
 *
 * Goal:
 * - Make regressions loud and repeatable.
 * - Keep logic simple and reversible (only runs checks; no writes/migrations).
 *
 * Run:
 *   npm run release:gates
 */

import { spawn } from 'node:child_process'

function npmBin() {
  // Prefer `npm` and let the platform resolve it (we enable `shell` on Windows below).
  return 'npm'
}

function run(cmd, args, { label } = {}) {
  return new Promise((resolve, reject) => {
    const pretty = `${cmd} ${args.join(' ')}`
    const name = label ? `[gate:${label}]` : '[gate]'
    console.log(`${name} start: ${pretty}`)

    // Windows: `npm`/`.cmd` resolution can fail with shell: false depending on environment.
    // Run via shell on Windows to make this robust for local dev + CI.
    const useShell = process.platform === 'win32'
    const child = spawn(cmd, args, { stdio: 'inherit', shell: useShell })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) {
        console.log(`${name} ok`)
        resolve()
        return
      }
      reject(new Error(`${name} failed (exit ${code})`))
    })
  })
}

async function main() {
  // Gate 0: CI/workstation guard — ensure Rollup native optional dep is present (npm optional-deps can be flaky on Linux CI).
  await run('node', ['scripts/ensure-rollup-native.mjs'], { label: 'rollup-native' })
  await run('node', ['scripts/guard-corruption-hotspots.mjs'], { label: 'corruption-hotspots' })

  // Gate 1: baseline quality + build
  await run(npmBin(), ['test'], { label: 'quality+build' })

  // Gate 2: contrast
  await run('node', ['--test', 'tests/unit/ui-dashboard-contrast.test.mjs'], { label: 'ui-contrast-dashboard' })
  await run('node', ['--test', 'tests/unit/ui-geo-crawl-contrast.test.mjs'], { label: 'ui-contrast-geo' })

  // Gate 3: auth/downloads
  await run('node', ['--test', 'tests/unit/avatar-download-auth.test.mjs'], { label: 'auth-avatar-download' })
  await run('node', ['--test', 'tests/unit/documents-download-auth.test.mjs'], { label: 'auth-doc-download' })

  // Gate 4: uploads persistence
  await run('node', ['--test', 'tests/unit/avatar-upload-and-download.test.mjs'], { label: 'uploads-avatar' })
  await run('node', ['--test', 'tests/unit/avatar-upload-persistence-restart.test.mjs'], { label: 'uploads-avatar-restart' })

  // Gate 5: Discover Grants: local funding directory resources survive filtering
  await run('node', ['scripts/verify-discover-grants-local-funding.mjs'], { label: 'discover-local-funding' })

  // Gate 6: Pipeline add-to-pipeline: no 500s under schema drift
  await run('node', ['--test', 'tests/unit/grants-add-to-pipeline-schema-drift.test.mjs'], { label: 'pipeline-add' })

  // Gate 7: Matching pipeline integration — profiles must always find real results
  await run('npx', ['vitest', 'run', 'backend/tests/matching-pipeline.test.js', '--reporter=verbose'], { label: 'matching-pipeline' })

  // Gate 8: Validation layer — URL format, required fields, duplicate detection
  await run('node', ['--test', 'tests/unit/opportunity-validation-layer.test.mjs'], { label: 'validation-layer' })

  // Gate 9: Multi-profile matching — individual/student/nonprofit/business must return results
  await run('node', ['--test', 'tests/unit/multi-profile-matching.test.mjs', 'tests/unit/validation-gate.test.mjs'], { label: 'multi-profile-matching' })

  console.log('[gate] all release gates passed')
}

main().catch((err) => {
  console.error('[gate] release gates failed:', err?.message || err)
  process.exitCode = 1
})

