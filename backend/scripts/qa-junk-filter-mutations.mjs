/**
 * Mutation verification for the 2026-08-03 QA junk-filter change set.
 *
 * CLAUDE.md trap honored: every mutation prints an explicit APPLIED and KILLED
 * verdict — a mutation that silently fails to apply is a check that cannot
 * fail (the CRLF-anchor incident). Each mutation is applied by exact
 * single-line substring replacement, the targeted suites are run, the
 * reddened count is recorded, and the file is restored from git.
 *
 * Run from the repo root:  node backend/scripts/qa-junk-filter-mutations.mjs
 * (Requires a clean working tree for the touched files — it restores them
 * with `git checkout --`.)
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
process.chdir(ROOT)

// Shell-free on purpose (no exec/execSync): arguments are static literals from
// this file, and execFileSync passes them as an array so nothing is ever
// interpreted by a shell.
const VITEST = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs')

function runTests(files) {
  try {
    const out = execFileSync(process.execPath, [VITEST, 'run', ...files], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000, cwd: ROOT,
    })
    return { out, code: 0 }
  } catch (err) {
    return { out: `${err.stdout ?? ''}${err.stderr ?? ''}`, code: err.status ?? 1 }
  }
}

function failedCount(out) {
  const m = out.match(/Tests\s+(\d+)\s+failed/)
  return m ? Number(m[1]) : 0
}

const MUTATIONS = [
  {
    name: 'M1 partition not_a_grant routing disabled',
    file: 'backend/services/matching/fundingSourcePresentation.js',
    from: 'if (verdict.bucket === RESULT_BUCKETS.NOT_A_GRANT) {',
    to: 'if (false && verdict.bucket === RESULT_BUCKETS.NOT_A_GRANT) {',
    tests: ['backend/tests/fundingResultFilters.test.js'],
  },
  {
    name: 'M2 canonical dedup disabled',
    file: 'backend/services/matching/fundingSourcePresentation.js',
    from: 'const { deduped, removed } = dedupeByCanonicalIdentity(list)',
    to: 'const { deduped, removed } = { deduped: list, removed: 0 }',
    tests: ['backend/tests/fundingResultFilters.test.js'],
  },
  {
    name: 'M3 engine foreign gate sees nothing',
    file: 'backend/services/matchEngine.js',
    from: 'const foreignJurisdiction = detectForeignOpportunity(opp)',
    to: 'const foreignJurisdiction = { foreign: false, cctld: null, host: null, funder: null }',
    tests: ['backend/tests/fundingResultFilters.test.js', 'backend/tests/matchScopeGates.test.js'],
  },
  {
    name: 'M4 profession gate neutered',
    file: 'backend/services/matchEngine.js',
    from: 'if (professionVerdict.ineligible) {',
    to: 'if (false && professionVerdict.ineligible) {',
    tests: ['backend/tests/fundingResultFilters.test.js'],
  },
  {
    name: 'M5 non-grant sweep adjudication no-op',
    file: 'backend/startup/enforceInvariants.js',
    replaces: [
      ["if (regulatory === 'regulatory_notice_title') {", 'if (false) {'],
      ['const leadGen = isLeadGenScholarship(row)', 'const leadGen = null && isLeadGenScholarship(row)'],
      ["if (expired && expired !== 'deadline_long_past') {", 'if (false) {'],
    ],
    tests: ['backend/tests/nonGrantNoticeSweep.test.js'],
  },
  {
    name: 'M6 foreign sweep funder-name predicate dropped',
    file: 'backend/startup/enforceInvariants.js',
    from: 'WHERE ${clause} OR ${nameClause}',
    to: 'WHERE ${clause}',
    tests: ['backend/tests/nonGrantNoticeSweep.test.js'],
  },
  {
    name: 'M7 item-lane chain removed',
    file: 'backend/services/itemNeedSearch.js',
    replaces: [
      ['const junkVerdict = classifyFundingResult(row)', "const junkVerdict = { bucket: 'fundable' }"],
      ['const geoVerdict = isRelevantGeo(row, { states: profileStates })', 'const geoVerdict = { relevant: true }'],
    ],
    tests: ['backend/tests/itemNeedSearch.test.js'],
  },
  {
    name: 'M8 frontend reset drops the profile again (pre-fix shape)',
    file: 'src/pages/itemFundingState.js',
    segmentAfter: 'export function resetFiltersPreservingProfile',
    from: 'includeNational: true,',
    to: 'includeNational: true,\n    profileId: "all",',
    tests: ['src/pages/ItemFunding.helpers.test.js'],
  },
  {
    name: 'M9 procedural-notice registry reverted to the narrow pre-QA list',
    file: 'backend/services/opportunityNormalizer.js',
    from: '|\\bagency information collection activities\\b|\\binformation collection\\b|\\bself-regulatory organizations?\\b|\\bnotice of filing\\b|\\bproposed rule change\\b|\\bprivacy act of 1974\\b|\\bsystems? of records\\b|\\bproposed final judgment\\b|\\bpublic hearing\\b|\\bprohibited transactions?\\b|\\bsolicitation of nominations?\\b/i',
    to: '/i',
    tests: ['backend/tests/fundingResultFilters.test.js'],
  },
]

let allKilled = true
for (const mut of MUTATIONS) {
  const filePath = path.join(ROOT, mut.file)
  const original = fs.readFileSync(filePath, 'utf8')
  let mutated = original
  let applied = true
  const pairs = mut.replaces ?? [[mut.from, mut.to]]
  if (mut.segmentAfter) {
    const idx = mutated.indexOf(mut.segmentAfter)
    if (idx < 0) applied = false
    else {
      const head = mutated.slice(0, idx)
      let tail = mutated.slice(idx)
      const [from, to] = pairs[0]
      if (!tail.includes(from)) applied = false
      else tail = tail.replace(from, to)
      mutated = head + tail
    }
  } else {
    for (const [from, to] of pairs) {
      if (!mutated.includes(from)) { applied = false; break }
      mutated = mutated.split(from).join(to)
    }
  }
  if (!applied) {
    console.log(`${mut.name}: applied=FALSE (anchor missing) killed=UNKNOWN  << FIX THE MUTATION`)
    allKilled = false
    continue
  }
  fs.writeFileSync(filePath, mutated)
  let reddened = 0
  try {
    const { out } = runTests(mut.tests)
    reddened = failedCount(out)
  } finally {
    execFileSync('git', ['checkout', '--', mut.file], { cwd: ROOT })
  }
  const killed = reddened > 0
  if (!killed) allKilled = false
  console.log(`${mut.name}: applied=true killed=${killed} (reddened ${reddened} test${reddened === 1 ? '' : 's'})`)
}
console.log(allKilled ? 'ALL MUTATIONS KILLED' : 'SOME MUTATIONS SURVIVED OR DID NOT APPLY')
process.exit(allKilled ? 0 : 1)
