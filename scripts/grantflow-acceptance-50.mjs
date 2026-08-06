#!/usr/bin/env node

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ACCEPTANCE_EXIT,
  DEFAULT_ALLOWED_PROVIDERS,
  runAmyWebParityAcceptance,
} from '../backend/services/acceptance/amyWebParityAcceptance.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ALLOWED_OPTIONS = new Set(['expected-sha', 'output', 'allowed-providers'])

function parseArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) throw new Error(`unexpected positional argument: ${token}`)
    const equal = token.indexOf('=')
    const key = token.slice(2, equal === -1 ? undefined : equal)
    if (!ALLOWED_OPTIONS.has(key)) throw new Error(`unsupported option: --${key}`)
    if (Object.hasOwn(parsed, key)) throw new Error(`duplicate option: --${key}`)
    let value = equal === -1 ? argv[index + 1] : token.slice(equal + 1)
    if (equal === -1) index += 1
    if (!value || value.startsWith('--')) throw new Error(`--${key} requires a value`)
    parsed[key] = value
  }
  if (!parsed['expected-sha']) throw new Error('--expected-sha is required')
  if (!parsed.output) throw new Error('--output is required')
  return parsed
}

function usage() {
  return [
    'Usage:',
    '  npm run acceptance:amy-parity -- --expected-sha=<40hex> --output=audit-reports/<receipt>.json [--allowed-providers=google_cse,searxng,brave]',
    '',
    'The command refuses a dirty worktree or SHA mismatch before creating any artifact.',
    'The output receipt path must be new; existing evidence is never overwritten.',
  ].join('\n')
}

async function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`[grantflow-acceptance-50] ${error?.message || error}`)
    console.error(usage())
    process.exitCode = ACCEPTANCE_EXIT.PREFLIGHT
    return
  }

  const allowedProviders = args['allowed-providers']
    ? args['allowed-providers'].split(',').map((value) => value.trim()).filter(Boolean)
    : DEFAULT_ALLOWED_PROVIDERS

  const result = await runAmyWebParityAcceptance({
    repoRoot,
    expectedSha: args['expected-sha'],
    output: args.output,
    allowedProviders,
  })

  const receipt = result.receipt
  console.log(`[grantflow-acceptance-50] status=${receipt.status} exit_code=${result.exitCode}`)
  console.log(`[grantflow-acceptance-50] sha=${receipt.source?.observed_sha || 'unverified'} target=50`)
  if (result.outputPath) console.log(`[grantflow-acceptance-50] receipt=${path.relative(repoRoot, result.outputPath)}`)
  if (receipt.error?.message) console.error(`[grantflow-acceptance-50] error=${receipt.error.message}`)
  process.exitCode = result.exitCode
}

main().catch((error) => {
  console.error(`[grantflow-acceptance-50] fatal=${error?.message || error}`)
  process.exitCode = ACCEPTANCE_EXIT.RUNTIME
})
