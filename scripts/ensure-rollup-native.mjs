/**
 * Workaround for npm optional-deps flakiness on CI:
 * Vite/Rollup may require a platform-specific optional package like:
 *   @rollup/rollup-linux-x64-gnu
 *
 * On some GitHub Actions runs, npm can skip optional deps and `vite build` fails with:
 *   Error: Cannot find module '@rollup/rollup-linux-x64-gnu'
 *
 * This script is:
 * - Traceable (logs what it did)
 * - Lightweight
 * - Reversible (no codegen; installs only when missing)
 *
 * Run:
 *   node scripts/ensure-rollup-native.mjs
 */

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

function resolveRollupNativePackage() {
  const platform = process.platform
  const arch = process.arch

  if (platform !== 'linux') return null
  if (arch === 'x64') return '@rollup/rollup-linux-x64-gnu'
  if (arch === 'arm64') return '@rollup/rollup-linux-arm64-gnu'
  return null
}

function hasModule(spec) {
  try {
    require.resolve(spec)
    return true
  } catch {
    return false
  }
}

function runNpmInstall(pkg) {
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const args = ['i', '--no-save', pkg]

  console.log(`[ensure-rollup-native] installing missing optional dep: ${pkg}`)
  const res = spawnSync(npmCmd, args, { stdio: 'inherit', shell: false })
  if (res.status !== 0) {
    throw new Error(`npm install failed (exit=${res.status}) for ${pkg}`)
  }
}

async function main() {
  const pkg = resolveRollupNativePackage()
  if (!pkg) {
    console.log('[ensure-rollup-native] skip (not a supported linux platform/arch)', {
      platform: process.platform,
      arch: process.arch,
    })
    return
  }

  if (hasModule(pkg)) {
    console.log('[ensure-rollup-native] ok (already present)', { pkg })
    return
  }

  runNpmInstall(pkg)

  if (!hasModule(pkg)) {
    throw new Error(`still missing after install: ${pkg}`)
  }

  console.log('[ensure-rollup-native] ok (installed)', { pkg })
}

main().catch((err) => {
  console.error('[ensure-rollup-native] failed:', err?.message || err)
  process.exitCode = 1
})

