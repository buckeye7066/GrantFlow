/**
 * Workaround for npm optional-deps flakiness on CI (Vercel/GitHub Actions):
 *
 * Vite/Rollup may require a platform-specific optional package like:
 *   @rollup/rollup-linux-x64-gnu
 *
 * Vite (via esbuild) may require a platform-specific package like:
 *   @esbuild/linux-x64
 *
 * npm can intermittently skip optional deps in CI; and running multiple
 * `npm i --no-save <pkg>` commands can cause npm to prune previously-installed
 * "extraneous" packages (even when we just installed them).
 *
 * So we install all missing native packages in ONE npm command.
 *
 * This script is:
 * - Traceable (logs what it did)
 * - Lightweight
 * - Reversible (installs only when missing)
 *
 * Run:
 *   node scripts/ensure-build-natives.mjs
 */

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)

function resolveNativePkgsForPlatform() {
  const platform = process.platform
  const arch = process.arch

  if (platform !== 'linux') return null

  if (arch === 'x64') {
    return ['@rollup/rollup-linux-x64-gnu', '@esbuild/linux-x64']
  }

  if (arch === 'arm64') {
    return ['@rollup/rollup-linux-arm64-gnu', '@esbuild/linux-arm64']
  }

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

function runNpmInstall(pkgs) {
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const args = ['i', '--no-save', ...pkgs]

  console.log(`[ensure-build-natives] installing missing native deps: ${pkgs.join(', ')}`)
  const res = spawnSync(npmCmd, args, { stdio: 'inherit', shell: false })
  if (res.status !== 0) {
    throw new Error(`npm install failed (exit=${res.status}) for: ${pkgs.join(', ')}`)
  }
}

async function main() {
  const pkgs = resolveNativePkgsForPlatform()
  if (!pkgs) {
    console.log('[ensure-build-natives] skip (not a supported linux platform/arch)', {
      platform: process.platform,
      arch: process.arch,
    })
    return
  }

  const missing = pkgs.filter((p) => !hasModule(p))
  if (missing.length === 0) {
    console.log('[ensure-build-natives] ok (already present)', { pkgs })
    return
  }

  runNpmInstall(missing)

  const stillMissing = pkgs.filter((p) => !hasModule(p))
  if (stillMissing.length > 0) {
    throw new Error(`still missing after install: ${stillMissing.join(', ')}`)
  }

  console.log('[ensure-build-natives] ok (installed)', { pkgs })
}

main().catch((err) => {
  console.error('[ensure-build-natives] failed:', err?.message || err)
  process.exitCode = 1
})

