import fs from 'node:fs'

const read = (file) => fs.readFileSync(file, 'utf8')
const write = (file, value) => fs.writeFileSync(file, value)

function countMatches(value, pattern) {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
  return value.match(new RegExp(pattern.source, flags))?.length || 0
}

function preflight(operation) {
  const source = read(operation.file)
  if (operation.type === 'replace') {
    const matches = countMatches(source, operation.pattern)
    if (matches !== 1) throw new Error(`${operation.label}: expected one match, found ${matches}`)
    return
  }
  const first = source.indexOf(operation.marker)
  if (first < 0 || source.indexOf(operation.marker, first + operation.marker.length) >= 0) {
    throw new Error(`${operation.label}: marker missing or ambiguous`)
  }
}

function apply(operation) {
  const source = read(operation.file)
  if (operation.type === 'replace') {
    write(operation.file, source.replace(operation.pattern, operation.replacement))
    return
  }
  const first = source.indexOf(operation.marker)
  write(
    operation.file,
    source.slice(0, first + operation.marker.length) + operation.addition + source.slice(first + operation.marker.length),
  )
}

const crawlerFile = 'backend/services/crawlerOsService.js'
const invariantFile = 'backend/startup/enforceInvariants.js'
const needFirstFile = 'backend/services/matching/needFirstReconciler.js'
const operations = []

const crawler = read(crawlerFile)
if (!crawler.includes('post_crawl_match_decision_integrity')) {
  operations.push({
    type: 'insert_after',
    file: crawlerFile,
    marker: `  } catch {
    /* post-crawl eligibility re-score must never fail the crawl */
  }`,
    addition: `

  // post_crawl_match_decision_integrity: eligibility and need-first scorers may
  // legitimately produce REJECT, but REJECT is never a surfaced match. Run the
  // structural pass after every post-persistence writer, including web-llm.
  try {
    if (!dryRun && String(ctx?.profile?.created_by ?? '') !== 'agent:amy') {
      const { normalizePersistedMatchDecisionIntegrity } = await import('./matching/matchDecisionIntegrity.js');
      await normalizePersistedMatchDecisionIntegrity(db, { profileId });
    }
  } catch {
    /* match-decision integrity is also re-asserted by the boot invariant net */
  }`,
    label: 'Post-crawl match decision integrity',
  })
}

const invariants = read(invariantFile)
if (!invariants.includes("from '../services/matching/matchDecisionIntegrity.js'")) {
  operations.push({
    type: 'insert_after',
    file: invariantFile,
    marker: `import { AMOUNT_ENRICH_ENV_MAX_ATTEMPTS, AMOUNT_ENRICH_ENV_REPROBE_LIMIT } from '../config/amountEnrichEnv.js'`,
    addition: `
import { normalizePersistedMatchDecisionIntegrity } from '../services/matching/matchDecisionIntegrity.js'`,
    label: 'Invariant match integrity import',
  })
}
if (!invariants.includes('export async function enforcePersistedMatchDecisionIntegrity')) {
  operations.push({
    type: 'insert_after',
    file: invariantFile,
    marker: `export async function enforceNoDanglingMatches(db) {`,
    addition: ``,
    label: 'placeholder',
  })
  // Replace the placeholder operation with a deterministic insert immediately
  // before the run orchestrator. Keeping this separate makes the marker stable
  // even as individual invariant bodies evolve.
  operations.pop()
  operations.push({
    type: 'replace',
    file: invariantFile,
    pattern: /\nexport async function runEnforceInvariants\(db, \{ logger = log \} = \{\}\) \{/,
    replacement: `
/**
 * INVARIANT: persisted surfaced matches obey the decision contract.
 * REJECT rows are removed, below-REVIEW resources are removed, and surviving
 * directory/referral/school-portal evidence is labelled REVIEW. This global,
 * idempotent boot net repairs legacy and web-llm rows regardless of writer.
 */
export async function enforcePersistedMatchDecisionIntegrity(db) {
  return runInvariant('persisted_match_decision_integrity', async () => {
    const result = await normalizePersistedMatchDecisionIntegrity(db)
    return {
      scanned: Number(result?.scanned_canonical_evidence || 0),
      repaired: Number(result?.repaired || 0),
      removedRejects: Number(result?.removed_rejects || 0),
      removedCanonicalRejects: Number(result?.removed_canonical_rejects || 0),
      removedBelowReviewResources: Number(result?.removed_below_review_resources || 0),
      normalizedResources: Number(result?.normalized_resources || 0),
      ...(result?.reason ? { skipped: result.reason } : {}),
    }
  })
}

export async function runEnforceInvariants(db, { logger = log } = {}) {`,
    label: 'Boot match decision invariant',
  })
}
if (!invariants.includes('steps.push(await enforcePersistedMatchDecisionIntegrity(db))')) {
  operations.push({
    type: 'insert_after',
    file: invariantFile,
    marker: `  steps.push(await enforceNoDanglingMatches(db))`,
    addition: `
  // Persisted-decision integrity AFTER dangling cleanup: no direct REJECT may
  // remain surfaced, and every surviving resource is REVIEW rather than ACCEPT.
  steps.push(await enforcePersistedMatchDecisionIntegrity(db))`,
    label: 'Boot invariant orchestration',
  })
}
if (!invariants.includes('  enforcePersistedMatchDecisionIntegrity,')) {
  operations.push({
    type: 'insert_after',
    file: invariantFile,
    marker: `  enforceNoDanglingMatches,`,
    addition: `
  enforcePersistedMatchDecisionIntegrity,`,
    label: 'Invariant test export',
  })
}

const needFirst = read(needFirstFile)
if (!needFirst.includes("from './matchDecisionIntegrity.js'")) {
  operations.push({
    type: 'insert_after',
    file: needFirstFile,
    marker: `import { NEED_FIRST_RECONCILIATION_ROWS_SQL } from './fundingSourceQueries.js'`,
    addition: `
import { normalizePersistedMatchDecisionIntegrity } from './matchDecisionIntegrity.js'`,
    label: 'Need-first integrity import',
  })
}
if (!needFirst.includes('match_decision_integrity: matchDecisionIntegrity')) {
  operations.push({
    type: 'insert_after',
    file: needFirstFile,
    marker: `  }

  const summary = {`,
    addition: ``,
    label: 'placeholder',
  })
  operations.pop()
  operations.push({
    type: 'replace',
    file: needFirstFile,
    pattern: /\n  const summary = \{/,
    replacement: `
  let matchDecisionIntegrity = null
  try {
    matchDecisionIntegrity = await normalizePersistedMatchDecisionIntegrity(db, { profileId })
  } catch (error) {
    failures.push({ opportunity_id: null, error: \`match decision integrity failed: \${error?.message || String(error)}\` })
  }

  const summary = {`,
    label: 'Need-first post-write integrity call',
  })
  operations.push({
    type: 'replace',
    file: needFirstFile,
    pattern: /    score_lowered: scoreLowered,\n    failures,/,
    replacement: `    score_lowered: scoreLowered,
    match_decision_integrity: matchDecisionIntegrity,
    failures,`,
    label: 'Need-first integrity summary',
  })
}

if (operations.length === 0) {
  console.log('[source-materialization] match-decision integrity already present')
} else {
  for (const operation of operations) preflight(operation)
  const originals = new Map([...new Set(operations.map((operation) => operation.file))]
    .map((file) => [file, read(file)]))
  try {
    for (const operation of operations) apply(operation)
  } catch (error) {
    for (const [file, original] of originals) write(file, original)
    throw error
  }
  console.log('[source-materialization] match-decision integrity applied')
}
