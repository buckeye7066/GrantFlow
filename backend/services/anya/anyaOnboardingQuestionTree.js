/**
 * ANYA_ONBOARDING_QUESTION_TREE
 *
 * Concrete, walkable decision tree of Anya's first-time-user onboarding.
 *
 * The tree is built from the field map: every leaf is a question
 * (referenced by `question_id`) and the order is the order Anya should
 * ask. The tree itself is intentionally declarative so:
 *
 *   - Any UI (the existing `/start` Anya conversation in PR #519, a
 *     future `/AnyaOnboarding`, or a CLI wizard) can walk it identically.
 *   - Sam can introspect it without running the UI.
 *
 * Walking rules:
 *   1. Start at the universal opening node.
 *   2. After the user picks a profile type, pivot into the matching
 *      branch sub-tree.
 *   3. Within a branch, ask required questions first, then recommended
 *      questions (only if the user chose `pace_preference: keep_asking`).
 *   4. Every non-identity question supports `answer | skip | i_dont_know`.
 *   5. A "complete" event is fired only after every required question has
 *      been answered, skipped, or marked I-don't-know.
 *
 * The tree never stores or echoes the user's free-text answers — it only
 * tracks per-question status. This is what Sam's transcript auditor reads.
 */

import {
  ANYA_ONBOARDING_FIELD_MAP,
  FIELD_MAP_BY_ID,
  questionsForBranch,
} from './anyaOnboardingFieldMap.js'
import {
  SUPPORTED_BRANCHES,
  UNIVERSAL_REQUIRED_FIELDS,
  BRANCH_CONTRACTS,
} from './anyaOnboardingIntakeContract.js'

const UNIVERSAL_OPENING_ORDER = [
  'universal.profile_type',
  'universal.profile_name',
  'universal.location_state',
  'universal.location_city',
  'universal.location_zip',
  'universal.who_needs_help',
  'universal.what_they_need',
  'universal.amount_or_unknown',
  'universal.urgency',
  'universal.preferred_help_types',
  'universal.short_description',
  'universal.pace_preference',
]

const UNIVERSAL_KEEP_ASKING_ORDER = [
  'universal.deadline',
  'universal.documents_available',
  'universal.known_eligibility_facts',
  'universal.contact_preference',
]

/**
 * Builds the branch sub-tree by ordering required first then recommended,
 * pulling the prompt + intake_field straight from the field map. Sensitive
 * questions are tagged (Sam's auditor enforces explanation/skippable).
 */
function buildBranchSubtree(branch) {
  const required = []
  const recommended = []

  for (const q of questionsForBranch(branch)) {
    if (q.branch === null) continue // universal handled separately
    const node = {
      question_id: q.question_id,
      intake_field: q.intake_field,
      prompt: q.prompt,
      sensitive: q.sensitive,
      required: Boolean(q.required),
      answer_modes: ['answer', 'skip', 'i_dont_know'],
    }
    if (q.required) required.push(node)
    else recommended.push(node)
  }

  return { required, recommended }
}

const BRANCH_SUBTREES = SUPPORTED_BRANCHES.reduce((acc, branch) => {
  acc[branch] = buildBranchSubtree(branch)
  return acc
}, {})

export const ANYA_ONBOARDING_QUESTION_TREE = Object.freeze({
  version: '1.0.0',
  flow: {
    universal_opening: UNIVERSAL_OPENING_ORDER.map((id) => toNode(id)),
    branches: Object.freeze(BRANCH_SUBTREES),
    universal_keep_asking: UNIVERSAL_KEEP_ASKING_ORDER.map((id) => toNode(id)),
  },
})

function toNode(question_id) {
  const q = FIELD_MAP_BY_ID[question_id]
  if (!q) {
    return {
      question_id,
      missing_from_field_map: true,
      answer_modes: ['answer', 'skip', 'i_dont_know'],
    }
  }
  return {
    question_id,
    intake_field: q.intake_field,
    prompt: q.prompt,
    sensitive: q.sensitive,
    required: q.required,
    answer_modes:
      q.question_id === 'universal.profile_type' || q.question_id === 'universal.profile_name'
        ? ['answer'] // identity questions cannot be skipped
        : ['answer', 'skip', 'i_dont_know'],
  }
}

/**
 * Synthetic walk of the tree for a given branch + pace. Returns the
 * full ordered list of nodes the user would see. Used by Sam's branch
 * tests and by tests in this PR.
 *
 * Accepts an optional `tree` argument so callers can audit a mutated copy
 * (Sam tests do this to verify the auditor catches drifted trees).
 */
export function walkOnboarding({ branch, pace = 'keep_asking', tree = ANYA_ONBOARDING_QUESTION_TREE } = {}) {
  if (!SUPPORTED_BRANCHES.includes(branch)) {
    return (tree?.flow?.universal_opening || []).slice()
  }
  const opening = (tree?.flow?.universal_opening || []).slice()
  const sub = tree?.flow?.branches?.[branch] || { required: [], recommended: [] }
  const branchRequired = (sub.required || []).slice()
  const branchRecommended = pace === 'quick_start' ? [] : (sub.recommended || []).slice()
  const universalRecommended = pace === 'quick_start' ? [] : (tree?.flow?.universal_keep_asking || []).slice()
  return [...opening, ...branchRequired, ...branchRecommended, ...universalRecommended]
}

/**
 * Returns every required intake_field this tree promises to elicit for a
 * branch (universal + branch). Used by the contract checker.
 */
export function intakeFieldsAskedForBranch(branch, tree = ANYA_ONBOARDING_QUESTION_TREE) {
  const visible = walkOnboarding({ branch, pace: 'keep_asking', tree })
  return new Set(visible.filter((n) => n.required).map((n) => n.intake_field))
}

/**
 * Returns the union of all sensitive questions in a branch. Used by Sam to
 * verify each one has explanation text + is optional.
 */
export function sensitiveQuestionsForBranch(branch, tree = ANYA_ONBOARDING_QUESTION_TREE) {
  return walkOnboarding({ branch, pace: 'keep_asking', tree }).filter((n) => n.sensitive)
}

/**
 * Stable hash-style fingerprint of a tree shape. Sam uses this to detect
 * tree drift across audit runs.
 */
export function fingerprintTree(tree = ANYA_ONBOARDING_QUESTION_TREE) {
  const ids = []
  for (const node of tree.flow.universal_opening) ids.push(`u:${node.question_id}`)
  for (const branch of SUPPORTED_BRANCHES) {
    const sub = tree.flow.branches[branch]
    for (const n of sub.required) ids.push(`b:${branch}:r:${n.question_id}`)
    for (const n of sub.recommended) ids.push(`b:${branch}:o:${n.question_id}`)
  }
  for (const node of tree.flow.universal_keep_asking) ids.push(`uk:${node.question_id}`)
  return ids.join('|')
}

export const __exposed = { UNIVERSAL_OPENING_ORDER, UNIVERSAL_KEEP_ASKING_ORDER }

// Re-export so callers don't need to import from two places.
export {
  ANYA_ONBOARDING_FIELD_MAP,
  FIELD_MAP_BY_ID,
  SUPPORTED_BRANCHES,
  UNIVERSAL_REQUIRED_FIELDS,
  BRANCH_CONTRACTS,
}
