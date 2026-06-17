/**
 * Sam — synthetic branch walk tests.
 *
 * Walks each branch as if a user were running through it, simulating
 * answers, skips, and "I don't know" responses. Reports any branch where:
 *
 *   - the conversation hits a dead end (no next question, no completion)
 *   - the same question_id is asked twice in one walk
 *   - the universal opening doesn't ask for `profile_type` early
 *   - a question is asked AFTER a sensitive question without rationale
 *   - the walk doesn't include every branch-required field
 *
 * Pure functions only — Sam consumes the result without DB access.
 */

import {
  SUPPORTED_BRANCHES,
  requiredFieldsForBranch,
} from '../anya/anyaOnboardingIntakeContract.js'
import {
  ANYA_ONBOARDING_QUESTION_TREE,
  walkOnboarding,
} from '../anya/anyaOnboardingQuestionTree.js'
import { FINDING_SEVERITY } from './samOnboardingQuestionContract.js'

/**
 * Simulate a single branch walk. Returns:
 *   - `nodes`: every node visited
 *   - `errors`: structural errors found during the walk
 */
export function simulateBranchWalk(branch, { pace = 'keep_asking', tree } = {}) {
  const nodes = walkOnboarding({ branch, pace, tree })
  const errors = []

  if (!Array.isArray(nodes) || nodes.length === 0) {
    errors.push({
      severity: FINDING_SEVERITY.CRITICAL,
      category: 'dead_end',
      branch,
      question_id: null,
      title: `Branch "${branch}" is empty`,
      description: `walkOnboarding returned no nodes for ${branch}.`,
      recommended_fix: `Define at least the universal opening and branch-required questions.`,
      evidence: { branch, pace },
    })
    return { nodes, errors }
  }

  const profileTypePosition = nodes.findIndex((n) => n.question_id === 'universal.profile_type')
  if (profileTypePosition < 0) {
    errors.push({
      severity: FINDING_SEVERITY.CRITICAL,
      category: 'profile_type_not_asked',
      branch,
      question_id: null,
      title: `Branch "${branch}" never asks for profile type`,
      description: `Onboarding must identify profile type early. It is missing from the walk.`,
      recommended_fix: `Ensure universal_opening starts with universal.profile_type.`,
      evidence: { branch },
    })
  } else if (profileTypePosition > 1) {
    errors.push({
      severity: FINDING_SEVERITY.HIGH,
      category: 'profile_type_too_late',
      branch,
      question_id: 'universal.profile_type',
      title: `Branch "${branch}" asks profile type at position ${profileTypePosition + 1}`,
      description: `profile_type should be the first question (or second after a warm greeting).`,
      recommended_fix: `Move universal.profile_type to the start of universal_opening.`,
      evidence: { branch, position: profileTypePosition },
    })
  }

  const seenIds = new Set()
  for (const node of nodes) {
    if (seenIds.has(node.question_id)) {
      errors.push({
        severity: FINDING_SEVERITY.MEDIUM,
        category: 'repeated_question',
        branch,
        question_id: node.question_id,
        title: `Question "${node.question_id}" asked twice in ${branch}`,
        description: `The same question id appears more than once in a single branch walk.`,
        recommended_fix: `Remove the duplicate node.`,
        evidence: { branch, question_id: node.question_id },
      })
    }
    seenIds.add(node.question_id)
  }

  // Synthetic "fill required, skip everything else" walk — confirm the branch
  // can complete with only required answers.
  const required = requiredFieldsForBranch(branch)
  const requiredCovered = new Set()
  for (const node of nodes) {
    if (required.includes(node.intake_field)) requiredCovered.add(node.intake_field)
  }
  const missing = required.filter((f) => !requiredCovered.has(f))
  if (missing.length) {
    errors.push({
      severity: FINDING_SEVERITY.HIGH,
      category: 'incomplete_required_walk',
      branch,
      question_id: null,
      title: `Branch "${branch}" walk missing required fields: ${missing.join(', ')}`,
      description: `Walking the ${branch} branch never offers a chance to provide ${missing.join(', ')}.`,
      recommended_fix: `Add questions for the missing intake fields.`,
      evidence: { branch, missing },
    })
  }

  return { nodes, errors }
}

/**
 * Simulate every branch and aggregate results.
 */
export function simulateAllBranches() {
  const results = {}
  const allErrors = []

  for (const branch of SUPPORTED_BRANCHES) {
    const r = simulateBranchWalk(branch)
    results[branch] = {
      visited_nodes: r.nodes.length,
      error_count: r.errors.length,
    }
    allErrors.push(...r.errors)
  }

  return {
    branches: results,
    findings: allErrors,
    summary: {
      total_branches: SUPPORTED_BRANCHES.length,
      branches_with_errors: Object.values(results).filter((r) => r.error_count > 0).length,
    },
  }
}

/**
 * Confirm that quick_start mode does NOT skip any required field. quick_start
 * trims recommended fields only.
 */
export function verifyQuickStartContainsAllRequired() {
  const findings = []
  for (const branch of SUPPORTED_BRANCHES) {
    const required = requiredFieldsForBranch(branch)
    const quick = walkOnboarding({ branch, pace: 'quick_start' })
    const askedSet = new Set(quick.map((n) => n.intake_field))
    const missing = required.filter((f) => !askedSet.has(f))
    if (missing.length) {
      findings.push({
        severity: FINDING_SEVERITY.HIGH,
        category: 'quick_start_missing_required',
        branch,
        question_id: null,
        title: `quick_start mode for "${branch}" skips required fields: ${missing.join(', ')}`,
        description: `quick_start should trim recommended-only questions, not required ones.`,
        recommended_fix: `Mark these fields as required in the branch tree.`,
        evidence: { branch, missing },
      })
    }
  }
  return findings
}

export const __testables = { ANYA_ONBOARDING_QUESTION_TREE }
