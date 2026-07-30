#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const file = path.resolve('backend/services/webParityBenchmark.js')
let source = fs.readFileSync(file, 'utf8')

function replaceOnce(before, after, label) {
  const first = source.indexOf(before)
  if (first < 0 || first !== source.lastIndexOf(before)) {
    throw new Error(`[web-parity-source-quality-finalize] ${label} missing or ambiguous`)
  }
  source = source.replace(before, after)
}

if (source.includes('if (!covers && !isBenchmarkRelevantHit(hit, { needs, applicantTypes })) continue')) {
  replaceOnce(
    `if (!covers && !isBenchmarkRelevantHit(hit, { needs, applicantTypes })) continue`,
    `if (!covers && !isBenchmarkDirectFundingHit(hit, { needs, applicantTypes })) continue`,
    'direct-funding classification gate',
  )
}

if (!source.includes('  isGenericFundingPortalHit,\n  isBenchmarkDirectFundingHit,')) {
  replaceOnce(
    `  isForeignGovernmentHit,
  isBenchmarkRelevantHit,
  parityScore,`,
    `  isForeignGovernmentHit,
  isBenchmarkRelevantHit,
  isGenericFundingPortalHit,
  isBenchmarkDirectFundingHit,
  parityScore,`,
    'direct-funding default exports',
  )
}

const required = [
  'export function isBenchmarkRelevantHit',
  'export function isGenericFundingPortalHit',
  'export function isBenchmarkDirectFundingHit',
  'if (!covers && !isBenchmarkDirectFundingHit(hit, { needs, applicantTypes })) continue',
  'function isTerminalGapStatus',
  'const WEB_ONLY_TOP_CAP = 20',
  "'thegrantportal.com'",
  "domain.endsWith('.' + noiseDomain)",
]
const missing = required.filter((signature) => !source.includes(signature))
if (missing.length > 0) {
  throw new Error('[web-parity-source-quality-finalize] final signatures missing: ' + missing.join(', '))
}

fs.writeFileSync(file, source)
console.log('[source-materialization] finalized web-parity direct-source gate and exports')
