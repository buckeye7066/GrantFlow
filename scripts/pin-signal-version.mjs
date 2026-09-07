#!/usr/bin/env node
/**
 * Re-pin PROFILE_SIGNAL_DERIVATION_HASH after bumping PROFILE_SIGNAL_VERSION.
 *
 *   node scripts/pin-signal-version.mjs          # rewrite the pinned hash
 *   node scripts/pin-signal-version.mjs --check  # print current vs pinned, exit 1 on drift
 *
 * See backend/config/profileSignalVersion.js for the rule this enforces.
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const configPath = path.join(root, 'backend', 'config', 'profileSignalVersion.js')
const mod = await import(`file:///${configPath.replace(/\\/g, '/')}`)

export function computeDerivationHash(files = mod.PROFILE_SIGNAL_DERIVATION_FILES, baseDir = root) {
  const h = createHash('sha256')
  for (const rel of files) {
    const text = readFileSync(path.join(baseDir, rel), 'utf8').replace(/\r\n/g, '\n')
    h.update(`${rel}\n${text}\n`)
  }
  return h.digest('hex')
}

const current = computeDerivationHash()
const check = process.argv.includes('--check')
if (check) {
  const same = current === mod.PROFILE_SIGNAL_DERIVATION_HASH
  console.log(`${same ? 'OK' : 'DRIFT'} version=${mod.PROFILE_SIGNAL_VERSION} pinned=${mod.PROFILE_SIGNAL_DERIVATION_HASH.slice(0, 12)} current=${current.slice(0, 12)}`)
  process.exit(same ? 0 : 1)
}
const src = readFileSync(configPath, 'utf8')
const next = src.replace(/export const PROFILE_SIGNAL_DERIVATION_HASH = '[^']*'/, `export const PROFILE_SIGNAL_DERIVATION_HASH = '${current}'`)
writeFileSync(configPath, next)
console.log(`pinned ${current} for PROFILE_SIGNAL_VERSION=${mod.PROFILE_SIGNAL_VERSION}`)
