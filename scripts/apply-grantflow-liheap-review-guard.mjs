import fs from 'node:fs'

const file = 'backend/services/greenHomeNoCostPolicy.js'
let source = fs.readFileSync(file, 'utf8')

const before = `  if (RETIRED_PROGRAM_PATTERNS.some((pattern) => pattern.test(text))) {
    return { status: 'excluded', reason: 'retired_or_rescinded_program', policy_version: POLICY_VERSION }
  }

  const structuredBlock = structuredCostBlock(result)`

const after = `  if (RETIRED_PROGRAM_PATTERNS.some((pattern) => pattern.test(text))) {
    return { status: 'excluded', reason: 'retired_or_rescinded_program', policy_version: POLICY_VERSION }
  }

  // Federal directory or benefit wording that says a local provider may offer
  // assistance is a useful starting path, not proof that the household pays
  // nothing. Keep it review-only even when surrounding prose contains words
  // such as "no household payment" while explaining what is not yet proven.
  if (result.no_cost_status === 'official_starting_path') {
    return { status: 'review', reason: 'no_cost_not_proven', policy_version: POLICY_VERSION }
  }

  const structuredBlock = structuredCostBlock(result)`

const first = source.indexOf(before)
if (first < 0) throw new Error('Missing classifier insertion point for LIHEAP review guard')
if (source.indexOf(before, first + before.length) >= 0) {
  throw new Error('Expected one classifier insertion point for LIHEAP review guard')
}
source = source.slice(0, first) + after + source.slice(first + before.length)
fs.writeFileSync(file, source)
console.log('Applied explicit official-starting-path review guard.')
