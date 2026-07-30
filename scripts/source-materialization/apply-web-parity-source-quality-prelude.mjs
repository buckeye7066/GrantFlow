#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const file = path.resolve('backend/services/webParityBenchmark.js')
let source = fs.readFileSync(file, 'utf8')

function replaceOnce(before, after, label) {
  const first = source.indexOf(before)
  if (first < 0 || first !== source.lastIndexOf(before)) {
    throw new Error(`[web-parity-source-quality-prelude] ${label} missing or ambiguous`)
  }
  source = source.replace(before, after)
}

if (!source.includes("'thegrantportal.com'")) {
  replaceOnce(
    `  'disabilityguidance.org',
]))`,
    `  'disabilityguidance.org',
  // Search/listing/referral pages are not direct award opportunities.
  'thegrantportal.com',
  'disability-grants.org',
  'themobilityresource.com',
]))`,
    'source-quality noise domains',
  )
}

if (source.includes('if (!domain || AGGREGATOR_NOISE_DOMAINS.has(domain)) return false')) {
  replaceOnce(
    `  if (!domain || AGGREGATOR_NOISE_DOMAINS.has(domain)) return false`,
    `  if (
    !domain ||
    [...AGGREGATOR_NOISE_DOMAINS].some(
      (noiseDomain) => domain === noiseDomain || domain.endsWith('.' + noiseDomain),
    )
  ) return false`,
    'subdomain-aware noise filter',
  )
}

if (source.includes('const WEB_ONLY_TOP_CAP = 5')) {
  replaceOnce('const WEB_ONLY_TOP_CAP = 5', 'const WEB_ONLY_TOP_CAP = 20', 'expanded web-only evidence')
}

if (!source.includes('export function isGenericFundingPortalHit')) {
  const marker = `export function isWebParityBenchmarkEnabled() {`
  const helpers = `const GENERIC_PORTAL_TITLE_RE =
  /^(?:home|search grants|browse grants|find grants|grant search|funding opportunities)(?:\\s*[|–—-]\\s*grants?\\.gov)?$/i
const GENERIC_GRANTS_GOV_PATH_RE =
  /^\\/(?:$|search-grants\\/?$|learn-grants(?:\\/.*)?$|applicants(?:\\/.*)?$|grantors(?:\\/.*)?$|support(?:\\/.*)?$)/i

/** A portal can contain real opportunities without itself being one. */
export function isGenericFundingPortalHit(hit) {
  const url = String(hit?.url || '').trim()
  const domain = extractHostname(url)
  const title = String(hit?.title || '').trim()
  if (GENERIC_PORTAL_TITLE_RE.test(title)) return true
  if (domain !== 'grants.gov') return false
  try {
    return GENERIC_GRANTS_GOV_PATH_RE.test(new URL(url).pathname || '/')
  } catch {
    return true
  }
}

/** Final direct-source gate for a purported web-only recall miss. */
export function isBenchmarkDirectFundingHit(hit, context = {}) {
  return isBenchmarkRelevantHit(hit, context) && !isGenericFundingPortalHit(hit)
}

${marker}`
  replaceOnce(marker, helpers, 'direct-source helper insertion')
}

fs.writeFileSync(file, source)
console.log('[source-materialization] prepared web-parity direct-source quality helpers')
