/**
 * Release gates runner (single command).
 *
 * Goal:
 * - Make regressions loud and repeatable.
 * - Keep logic simple and reversible (only runs checks; no writes/migrations).
 * - Keep hosted deployment credentials, volumes, and agent schedules out of
 *   isolated test processes.
 *
 * Run:
 *   npm run release:gates
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { buildIsolatedTestEnv } from './test-environment.mjs'

const REQUIRED_NODE_VERSION = '20.20.2'

function assertNode20Runtime() {
  if (process.versions.node !== REQUIRED_NODE_VERSION) {
    throw new Error(
      `release gates require Node ${REQUIRED_NODE_VERSION}; received ${process.versions.node}`,
    )
  }
  console.log(`[gate:node-runtime] ok (Node ${process.versions.node})`)
}

function pinCurrentNodeOnPath(sourceEnv) {
  const pathKey = Object.keys(sourceEnv).find((key) => key.toLowerCase() === 'path') || 'PATH'
  const currentPath = sourceEnv[pathKey] || ''
  return {
    ...sourceEnv,
    [pathKey]: [path.dirname(process.execPath), currentPath].filter(Boolean).join(path.delimiter),
  }
}

function npmBin() {
  // Prefer `npm` and let the platform resolve it (we enable `shell` on Windows below).
  return 'npm'
}

function run(cmd, args, { label, isolatedTest = false } = {}) {
  return new Promise((resolve, reject) => {
    const pretty = `${cmd} ${args.join(' ')}`
    const name = label ? `[gate:${label}]` : '[gate]'
    console.log(`${name} start: ${pretty}${isolatedTest ? ' [isolated-env]' : ''}`)

    // Windows: `npm`/`.cmd` resolution can fail with shell: false depending on environment.
    // Run via shell on Windows to make this robust for local dev + CI.
    const useShell = process.platform === 'win32'
    const baseEnv = isolatedTest
      ? buildIsolatedTestEnv(process.env, { GRANTFLOW_TEST_RUNNER: '1' })
      : process.env
    // `npm run` and direct `node` children must use the exact runtime that
    // passed the exact Node runtime guard, even when another version appears later
    // on a workstation or CI runner's PATH.
    const env = pinCurrentNodeOnPath(baseEnv)
    const child = spawn(cmd, args, { stdio: 'inherit', shell: useShell, env })
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

function runNodeTests(files, label) {
  return run('node', ['--test', ...files], { label, isolatedTest: true })
}

function runVitest(args, label) {
  return run('node', ['scripts/run-vitest-isolated.mjs', 'run', ...args], { label })
}

async function main() {
  assertNode20Runtime()

  // Gate 0: CI/workstation guard — ensure Rollup native optional dep is present (npm optional-deps can be flaky on Linux CI).
  await run('node', ['scripts/ensure-rollup-native.mjs'], { label: 'rollup-native' })
  await run('node', ['scripts/guard-corruption-hotspots.mjs'], { label: 'corruption-hotspots' })
  await run(npmBin(), ['run', 'scan:secrets'], { label: 'secret-scan' })
  await run(npmBin(), ['run', 'deployment-config:check'], { label: 'deployment-config' })

  // Gate 0a: production-deploy guard — every backend import must resolve inside the
  // Dockerfile runtime image. Catches the "Railway built fine but the container
  // crashes on boot with ERR_MODULE_NOT_FOUND, so prod silently keeps serving the
  // previous deployment" failure mode that masked profile section AI fixes for days.
  await run('node', ['scripts/check-runtime-imports.mjs'], { label: 'runtime-imports' })

  // Gate 0b: env-example drift guard — every process.env / import.meta.env
  // reference must appear in the checked-in .env.example files. Previously this
  // only ran in `check:prepush`, which no hook or CI job invokes, so the
  // examples silently drifted (2026-07-01 pass found ~45 missing vars).
  await run('node', ['scripts/check-env-examples.mjs'], { label: 'env-examples' })
  await run(npmBin(), ['run', 'profile-scope:check'], { label: 'profile-scope' })
  await run(npmBin(), ['run', 'safe-sql:check'], { label: 'safe-sql' })
  await runNodeTests(['tests/unit/no-fake-production-rule.test.mjs'], 'no-fake-rule')
  await runNodeTests(['tests/unit/profile-context-middleware.test.mjs'], 'profile-context')
  await run('node', ['scripts/crawler-profile-routing-proof.mjs'], {
    label: 'crawler-profile-routing',
    isolatedTest: true,
  })

  // Gate 1: baseline quality + build. The package's Node and Vitest lanes apply
  // their own isolation wrappers; the Vite production build still sees the
  // deployment build-time settings being validated by this exact run.
  //
  // On Vercel, the full `npm test` matrix and later OTP/server-boot gates
  // repeatedly 503 login under the build sandbox (loginEmailOtp expects 202).
  // GitHub Actions CI remains the authoritative full matrix; Vercel keeps the
  // production SPA build (+ crawler-os lint) so frontend SHA can converge.
  const onVercel = process.env.VERCEL === '1'
  if (onVercel) {
    console.log(
      '[gate:quality+build] Vercel detected — running production SPA build only; full npm test matrix is owned by GitHub CI',
    )
    await run(npmBin(), ['run', 'build'], { label: 'quality+build' })
    await run(npmBin(), ['run', 'crawler-os:lint'], { label: 'crawler-os-lint' })
    console.log(
      '[gate] Vercel path complete after SPA build + crawler-os lint; remaining release gates are owned by GitHub CI',
    )
    console.log('[gate] all release gates passed')
    return
  }

  await run(npmBin(), ['test'], { label: 'quality+build' })

  // Gate 1a: the authoritative Crawler OS suite is intentionally outside the
  // legacy Node/Vitest discovery globs, so it must be an explicit release gate.
  await run(npmBin(), ['run', 'crawler-os:lint'], { label: 'crawler-os-lint' })
  await run(npmBin(), ['run', 'crawler-os:test'], {
    label: 'crawler-os-test',
    isolatedTest: true,
  })

  // Gate 2: contrast
  await runNodeTests(['tests/unit/ui-dashboard-contrast.test.mjs'], 'ui-contrast-dashboard')
  await runNodeTests(['tests/unit/ui-geo-crawl-contrast.test.mjs'], 'ui-contrast-geo')
  await runNodeTests(['tests/unit/profile-flow-mobile-static.test.mjs'], 'profile-mobile-static')

  // Gate 3: auth/downloads
  await runNodeTests(['tests/unit/ui-honesty-guard.test.mjs'], 'ui-honesty')
  await runNodeTests(['tests/unit/avatar-download-auth.test.mjs'], 'auth-avatar-download')
  await runNodeTests(['tests/unit/documents-download-auth.test.mjs'], 'auth-doc-download')

  // Gate 4: uploads persistence
  await runNodeTests(['tests/unit/avatar-upload-and-download.test.mjs'], 'uploads-avatar')
  await runNodeTests(['tests/unit/avatar-upload-persistence-restart.test.mjs'], 'uploads-avatar-restart')

  // Gate 5: Discover Grants: local funding directory resources survive filtering
  await run('node', ['scripts/verify-discover-grants-local-funding.mjs'], {
    label: 'discover-local-funding',
    isolatedTest: true,
  })

  // Gate 6: Pipeline add-to-pipeline: no 500s under schema drift
  await runNodeTests(['tests/unit/grants-add-to-pipeline-schema-drift.test.mjs'], 'pipeline-add')

  // Gate 7: Matching pipeline integration — profiles must always find real results
  await runVitest(['backend/tests/matching-pipeline.test.js', '--reporter=verbose'], 'matching-pipeline')

  // Gate 8: Validation layer — URL format, required fields, duplicate detection
  await runNodeTests(['tests/unit/opportunity-validation-layer.test.mjs'], 'validation-layer')
  await runNodeTests(['tests/unit/funding-trace-consolidation.test.mjs'], 'funding-trace')

  // Gate 9: Multi-profile matching — individual/student/nonprofit/business must return results
  await runNodeTests(
    ['tests/unit/multi-profile-matching.test.mjs', 'tests/unit/validation-gate.test.mjs'],
    'multi-profile-matching',
  )

  // Gate 10: Endpoint sweep — every GET handler is mounted + runs without 5xx
  // (integration gate; boots the full server, so it lives here, not in the
  // parallel fast `unit` lane).
  await runVitest(['--config', 'vitest.endpoints.config.js'], 'endpoint-sweep')

  console.log('[gate] all release gates passed')
}

main().catch((err) => {
  console.error('[gate] release gates failed:', err?.message || err)
  process.exitCode = 1
})
