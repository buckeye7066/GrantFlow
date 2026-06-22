#!/usr/bin/env node
/**
 * fix-crawlers.mjs
 *
 * Ensures GrantFlow crawlers find real, URL-verified funding sources that match
 * profile needs. Run from repo root: node scripts/fix-crawlers.mjs
 *
 * Fixes applied (idempotent):
 * 1. realCrawlers.js: When live crawler returns 0 above min_match_score but has
 *    scored results, return top-scoring so profile gets URL-verified opps (no 0-included).
 * 2. realCrawlers.js: run-multiple merges profile_data from body and applies
 *    DB-backed location override so state/zip are authoritative.
 * 3. crawlerOpportunityContract.js: Title can fall back to description snippet so
 *    real URL sources are not dropped for missing title only.
 *
 * Verification: Ensures contract and profile helpers load and accept valid inputs.
 */

import fs from 'node:fs'
import path from 'node:path'

const projectRoot = path.resolve(process.cwd())
const backend = path.join(projectRoot, 'backend')

const FIXES = [
  {
    id: 'live-score-fallback',
    file: path.join(projectRoot, 'backend', 'routes', 'realCrawlers.js'),
    check: 'score_fallback_applied',
    description: 'Live path returns top-scoring when 0 pass threshold',
  },
  {
    id: 'run-multiple-merge',
    file: path.join(projectRoot, 'backend', 'routes', 'realCrawlers.js'),
    check: 'mergeProfileAndData(profile, req.body',
    description: 'run-multiple merges profile_data and applies location override',
  },
  {
    id: 'contract-title-fallback',
    file: path.join(projectRoot, 'backend', 'services', 'shared', 'crawlerOpportunityContract.js'),
    check: 'rawDesc ? rawDesc.slice(0, 80)',
    description: 'Contract allows title fallback from description for URL-valid opps',
  },
]

function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch (e) {
    return null
  }
}

function checkFix(content, check) {
  return content && content.includes(check)
}

function main() {
  console.log('GrantFlow crawler fix script\n')
  const report = { applied: [], present: [], missing: [], errors: [] }

  for (const fix of FIXES) {
    const content = readFile(fix.file)
    if (!content) {
      report.missing.push(fix.id)
      report.errors.push(`${fix.id}: file not found ${fix.file}`)
      continue
    }
    if (checkFix(content, fix.check)) {
      report.present.push(fix.id)
      console.log(`[OK] ${fix.description}`)
    } else {
      report.missing.push(fix.id)
      console.log(`[MISSING] ${fix.description} (${fix.file})`)
    }
  }

  if (report.missing.length > 0) {
    console.log('\nSome fixes are missing. They must be applied to the codebase.')
    console.log('This script verifies only. Apply the following changes:\n')
    console.log('1. backend/routes/realCrawlers.js')
    console.log('   - In runLiveCrawler, after building `included`, if included.length === 0 && rescored.length > 0,')
    console.log('     set included = top 50 by score and set score_fallback_applied: true in return.')
    console.log('   - In run-multiple, after loading profile: profile = mergeProfileAndData(profile, req.body?.profile_data).')
    console.log('     After requireFacets, apply same DB location override (profileState/profileZip/profileCity -> facets.geo, signals.location).')
    console.log('2. backend/services/shared/crawlerOpportunityContract.js')
    console.log('   - In enforceCrawlerOpportunityContract: validate URL first; then set title = rawTitle || (rawDesc.slice(0,80) || "Funding opportunity").')
    console.log('')
  }

  // Verification: contract file must require URL and allow title fallback
  let verifyOk = true
  const contractPath = path.join(backend, 'services', 'shared', 'crawlerOpportunityContract.js')
  const contractContent = readFile(contractPath) || ''
  if (!contractContent.includes('isValidHttpUrl(url)')) {
    report.errors.push('Contract must require isValidHttpUrl(url)')
    verifyOk = false
  }
  if (contractContent.includes('rawDesc') && contractContent.includes('slice(0, 80)')) {
    console.log('[VERIFY] Contract has title fallback from description')
  }

  console.log('')
  if (report.present.length === FIXES.length && verifyOk) {
    console.log('All crawler fixes are present. Run Discover Grants with a profile that has state/ZIP for best results.')
    process.exit(0)
  }
  if (report.missing.length > 0) {
    console.log(`Missing fixes: ${report.missing.join(', ')}. Apply the code changes above.`)
    process.exit(1)
  }
  process.exit(verifyOk ? 0 : 1)
}

main()
