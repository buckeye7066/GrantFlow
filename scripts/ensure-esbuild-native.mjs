/**
 * Workaround for npm optional-deps flakiness on CI:
 * esbuild requires a platform-specific package like:
 *   @esbuild/linux-x64
 *
 * On some CI runs, npm can skip optional deps and `vite build` fails with:
 *   Error: The package "@esbuild/linux-x64" could not be found, and is needed by esbuild.
 *
 * This script is:
 * - Traceable (logs what it did)
 * - Lightweight
 * - Reversible (installs only when missing)
 *
 * Run:
 *   node scripts/ensure-esbuild-native.mjs
 */

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)

function resolveEsbuildNativePackage() {
  const platform = process.platform
  const arch = process.arch

  if (platform !== 'linux') return null
  if (arch === 'x64') return '@esbuild/linux-x64'
  if (arch === 'arm64') return '@esbuild/linux-arm64'
  return null
}

function hasModule(spec) {
  // Prefer a filesystem check first: in some CI environments `require.resolve()`
  // can behave unexpectedly after an in-process `npm i`.
  try {
    const pkgPath = path.join(process.cwd(), 'node_modules', ...String(spec).split('/'), 'package.json')
    if (existsSync(pkgPath)) return true
  } catch {
    // ignore
  }
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

  console.log(`[ensure-esbuild-native] installing missing optional dep: ${pkg}`)
  const res = spawnSync(npmCmd, args, { stdio: 'inherit', shell: false })
  if (res.status !== 0) {
    throw new Error(`npm install failed (exit=${res.status}) for ${pkg}`)
  }
}

async function main() {
  const pkg = resolveEsbuildNativePackage()
  if (!pkg) {
    console.log('[ensure-esbuild-native] skip (not a supported linux platform/arch)', {
      platform: process.platform,
      arch: process.arch,
    })
    return
  }

  if (hasModule(pkg)) {
    console.log('[ensure-esbuild-native] ok (already present)', { pkg })
    return
  }

  runNpmInstall(pkg)

  if (!hasModule(pkg)) {
    throw new Error(`still missing after install: ${pkg}`)
  }

  console.log('[ensure-esbuild-native] ok (installed)', { pkg })
}

main().catch((err) => {
  console.error('[ensure-esbuild-native] failed:', err?.message || err)
  process.exitCode = 1
})

