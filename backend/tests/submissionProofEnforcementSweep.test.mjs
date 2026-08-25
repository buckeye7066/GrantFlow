/**
 * submissionProofEnforcementSweep.test.mjs
 *
 * submissionProofPredicate.js encodes the owner's north star: never present
 * something as "externally submitted" when it is only an internal record. That
 * invariant is currently maintained by DISCIPLINE — four modules import the
 * predicate, while ~107 sites across routes/ and services/ assert the string
 * 'submitted'. Discipline does not survive contributors or agents.
 *
 * This suite converts the invariant into something the suite enforces:
 *
 *   1. Every module that SHAPES a user-facing submitted status must reach the
 *      proof predicate. A module that reads submitted status and emits a label
 *      without consulting proof is a regression.
 *   2. The predicate itself must never promote a packet/draft/proposal document
 *      to proof.
 *   3. The legacy unaudited outcome route must stay fenced.
 *
 * DELIBERATELY A STATIC SWEEP, not a live-DB test: it must run offline in CI
 * and fail on a newly-added bypass rather than only on an exercised code path.
 */

import { describe, it, expect } from 'vitest'
import { readFile, readdir } from 'node:fs/promises'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BACKEND = join(HERE, '..')

const PREDICATE_MARKERS = [
  'submissionProofPredicate',
  'assessTaskSubmissionProof',
  'taskHasVerifiedExternalSubmission',
  'applicationLifecycleReadModel',
  'SUBMISSION_PROOF_STATE',
]

/**
 * Modules that legitimately hold submitted status WITHOUT consulting proof.
 * Each entry needs a reason. Adding one is a deliberate, reviewable act — that
 * is the point of the allowlist.
 */
const ENFORCEMENT_ALLOWLIST = new Map([
  ['services/hamilton/applicationTaskStore.js', 'owns the status column and imports the predicate directly'],
  ['services/hamilton/submissionProofPredicate.js', 'is the predicate'],
  ['services/hamilton/hamiltonConfirmationArtifacts.js', 'is the proof-artifact pipeline the predicate delegates to'],
  ['services/hamilton/manualSubmissionReceiptStore.js', 'is the owner-attested receipt authority'],
  ['services/applicationLifecycleReadModel.js', 'is the evidence-aware read model'],
])

async function walk(dir, out = []) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (['node_modules', 'tests', '__tests__', 'fixtures'].includes(entry.name)) continue
      await walk(full, out)
    } else if (entry.name.endsWith('.js') && !entry.name.includes('.test.')) {
      out.push(full)
    }
  }
  return out
}

/**
 * A module "presents" submitted status when it builds user-facing text or a
 * response field out of a submitted state — as opposed to merely writing the
 * column or filtering a query by it.
 */
function presentsSubmittedStatus(source) {
  if (!/['"]submitted['"]/.test(source)) return false

  // Scope to APPLICATION-TASK submission. Without this, the sweep fires on
  // unrelated domains that legitimately own a 'submitted' string — FAFSA
  // stage tracking, SQL ORDER BY rankings, AI-timeout labels — and a test that
  // cries wolf gets muted, which is worse than no test.
  const taskContext = [
    /application_tasks/,
    /applicationTask/,
    /\btask\.status\b/,
    /task_status/,
    /hamilton_autopilot_runs/,
  ]
  if (!taskContext.some((re) => re.test(source))) return false

  // And require that it actually renders that status to a human, rather than
  // writing the column or filtering a query by it.
  const presentationSignals = [
    /status_label/i,
    /statusLabel/,
    /display_status/i,
    /displayStatus/,
    /submission_label/i,
    /humanize|prettify|toDisplay/i,
  ]
  return presentationSignals.some((re) => re.test(source))
}

describe('submission proof enforcement sweep', () => {
  it('every module presenting submitted status reaches the proof predicate', async () => {
    const roots = [join(BACKEND, 'routes'), join(BACKEND, 'services')]
    const files = (await Promise.all(roots.map((r) => walk(r)))).flat()

    const violations = []
    for (const file of files) {
      const rel = relative(BACKEND, file).split('\\').join('/')
      if (ENFORCEMENT_ALLOWLIST.has(rel)) continue

      let source
      try {
        source = await readFile(file, 'utf8')
      } catch {
        continue
      }
      if (!presentsSubmittedStatus(source)) continue
      if (PREDICATE_MARKERS.some((marker) => source.includes(marker))) continue

      violations.push(rel)
    }

    expect(
      violations,
      [
        'These modules build a user-facing submitted status without consulting',
        'submissionProofPredicate. Either route the status through',
        'assessTaskSubmissionProof / applicationLifecycleReadModel, or add the',
        'module to ENFORCEMENT_ALLOWLIST with a reason:',
        ...violations.map((v) => `  - ${v}`),
      ].join('\n'),
    ).toEqual([])
  })

  it('the predicate never treats a generated packet as proof', async () => {
    const source = await readFile(
      join(BACKEND, 'services/hamilton/submissionProofPredicate.js'),
      'utf8',
    )
    // The packet type must be explicitly excluded, not merely unmentioned.
    expect(source).toMatch(/output_document_is_|output_document_not_confirmation/)
    expect(source).toContain('CONFIRMATION_DOCUMENT_TYPE')
    // The three states must remain exhaustive.
    expect(source).toContain('VERIFIED_EXTERNAL')
    expect(source).toContain('INTERNAL_ONLY')
    expect(source).toContain('NOT_SUBMITTED')
  })

  it('the legacy unaudited outcome route stays fenced', async () => {
    const source = await readFile(join(BACKEND, 'routes/grantApplications.js'), 'utf8')
    expect(source).toContain('OUTCOME_EVIDENCE_REQUIRED')
    expect(source).toMatch(/status\(422\)/)
  })

  it('the allowlist itself does not silently grow stale', async () => {
    for (const [rel] of ENFORCEMENT_ALLOWLIST) {
      const source = await readFile(join(BACKEND, rel), 'utf8').catch(() => null)
      expect(source, `allowlisted module no longer exists: ${rel}`).not.toBeNull()
    }
  })
})
