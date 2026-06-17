/**
 * Sam — onboarding question-contract checker.
 *
 * Reads a question tree (default: the canonical Anya tree) and the intake
 * contract, then reports every gap, duplicate, and irrelevant question.
 *
 * Pure function — no DB, no I/O. Returns structured findings the
 * orchestrator can persist.
 */

import {
  ANYA_ONBOARDING_INTAKE_CONTRACT,
  SUPPORTED_BRANCHES,
  UNIVERSAL_REQUIRED_FIELDS,
  BRANCH_CONTRACTS,
  requiredFieldsForBranch,
  sensitiveFieldsForBranch,
} from '../anya/anyaOnboardingIntakeContract.js'
import {
  ANYA_ONBOARDING_QUESTION_TREE,
  walkOnboarding,
  intakeFieldsAskedForBranch,
  fingerprintTree,
} from '../anya/anyaOnboardingQuestionTree.js'
import { ANYA_ONBOARDING_FIELD_MAP, FIELD_MAP_BY_ID } from '../anya/anyaOnboardingFieldMap.js'

export const FINDING_SEVERITY = Object.freeze({
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
  INFO: 'info',
})

const SEVERITY_FOR_MISSING_REQUIRED = FINDING_SEVERITY.HIGH
const SEVERITY_FOR_MISSING_UNIVERSAL = FINDING_SEVERITY.CRITICAL
const SEVERITY_FOR_DUPLICATE = FINDING_SEVERITY.MEDIUM
const SEVERITY_FOR_UNMAPPED = FINDING_SEVERITY.HIGH
const SEVERITY_FOR_SENSITIVE_NO_RATIONALE = FINDING_SEVERITY.MEDIUM
const SEVERITY_FOR_MISSING_SKIP_PATH = FINDING_SEVERITY.MEDIUM

/**
 * @typedef {Object} ContractFinding
 * @property {string}  severity
 * @property {string}  category
 * @property {string|null} branch
 * @property {string|null} question_id
 * @property {string}  title
 * @property {string}  description
 * @property {string}  recommended_fix
 * @property {object}  evidence
 */

/**
 * @returns {{
 *   findings: ContractFinding[],
 *   coverage: object,
 *   fingerprint: string,
 * }}
 */
export function checkOnboardingContract({
  contract = ANYA_ONBOARDING_INTAKE_CONTRACT,
  tree = ANYA_ONBOARDING_QUESTION_TREE,
  fieldMap = ANYA_ONBOARDING_FIELD_MAP,
} = {}) {
  /** @type {ContractFinding[]} */
  const findings = []

  // ── 1. Universal required coverage ─────────────────────────────────────────
  const universalCovered = new Set()
  for (const node of tree.flow.universal_opening) {
    if (node.intake_field) universalCovered.add(node.intake_field)
  }

  const universalMissing = UNIVERSAL_REQUIRED_FIELDS.filter((f) => !universalCovered.has(f))
  for (const intakeField of universalMissing) {
    findings.push({
      severity: SEVERITY_FOR_MISSING_UNIVERSAL,
      category: 'missing_universal_question',
      branch: null,
      question_id: null,
      title: `Universal flow missing required intake field: ${intakeField}`,
      description: `The intake contract requires "${intakeField}" before any branch begins, but the question tree never asks for it.`,
      recommended_fix: `Add a universal question that elicits "${intakeField}" and map it via anyaOnboardingFieldMap.`,
      evidence: { intake_field: intakeField },
    })
  }

  // ── 2. Branch-required coverage ────────────────────────────────────────────
  /** @type {Record<string, { required_total: number, required_covered: number, missing: string[], total_questions: number }>} */
  const branchCoverage = {}

  for (const branch of SUPPORTED_BRANCHES) {
    const branchContract = BRANCH_CONTRACTS[branch]
    if (!branchContract) continue
    const required = requiredFieldsForBranch(branch)
    const askedSet = intakeFieldsAskedForBranch(branch, tree)
    const missing = required.filter((f) => !askedSet.has(f))
    const totalQuestions = walkOnboarding({ branch, pace: 'keep_asking', tree }).length

    branchCoverage[branch] = {
      required_total: required.length,
      required_covered: required.length - missing.length,
      missing,
      total_questions: totalQuestions,
    }

    for (const intakeField of missing) {
      findings.push({
        severity: SEVERITY_FOR_MISSING_REQUIRED,
        category: 'missing_branch_question',
        branch,
        question_id: null,
        title: `Branch "${branch}" missing required intake field: ${intakeField}`,
        description: `The intake contract requires "${intakeField}" for the ${branch} branch, but the question tree never asks for it.`,
        recommended_fix: `Add a question to the ${branch} sub-tree that elicits "${intakeField}".`,
        evidence: { branch, intake_field: intakeField },
      })
    }
  }

  // ── 3. Duplicate intake_field coverage within a single branch path ─────────
  for (const branch of SUPPORTED_BRANCHES) {
    const seen = new Map()
    for (const node of walkOnboarding({ branch, pace: 'keep_asking', tree })) {
      if (!node.intake_field) continue
      if (seen.has(node.intake_field)) {
        findings.push({
          severity: SEVERITY_FOR_DUPLICATE,
          category: 'duplicate_question',
          branch,
          question_id: node.question_id,
          title: `Duplicate intake field "${node.intake_field}" in ${branch} branch`,
          description: `Both ${seen.get(node.intake_field)} and ${node.question_id} map to the same intake field in the ${branch} flow.`,
          recommended_fix: `Remove or merge one of the duplicate questions.`,
          evidence: { branch, intake_field: node.intake_field, first: seen.get(node.intake_field), second: node.question_id },
        })
      } else {
        seen.set(node.intake_field, node.question_id)
      }
    }
  }

  // ── 4. Field-map mapping gaps ──────────────────────────────────────────────
  /** Every fieldMap entry should have at least one profile-field destination
   * (a few identity questions like profile_type intentionally store metadata
   * elsewhere; pace_preference legitimately writes nowhere). */
  const ALLOW_NO_MAPPING = new Set(['universal.pace_preference'])
  for (const q of fieldMap) {
    if (ALLOW_NO_MAPPING.has(q.question_id)) continue
    if (!Array.isArray(q.maps_to_profile_fields) || q.maps_to_profile_fields.length === 0) {
      findings.push({
        severity: SEVERITY_FOR_UNMAPPED,
        category: 'field_mapping_gap',
        branch: q.branch,
        question_id: q.question_id,
        title: `Question "${q.question_id}" maps to no profile field`,
        description: `Every onboarding question (other than pace) should write at least one profile field. "${q.question_id}" writes none.`,
        recommended_fix: `Add a maps_to_profile_fields entry, or move this to ALLOW_NO_MAPPING with a clear reason.`,
        evidence: { question_id: q.question_id, branch: q.branch },
      })
    }
  }

  // ── 5. Sensitive questions: require explanation + skip path ────────────────
  for (const branch of SUPPORTED_BRANCHES) {
    for (const node of walkOnboarding({ branch, pace: 'keep_asking', tree })) {
      if (!node.sensitive) continue

      const fmEntry = FIELD_MAP_BY_ID[node.question_id]
      // Prefer the node-level prompt (so callers can audit a mutated tree
      // copy) and fall back to the canonical field map.
      const promptText = String(node.prompt || fmEntry?.prompt || '').toLowerCase()
      const explainsRationale =
        promptText.includes('optional') ||
        promptText.includes('private') ||
        promptText.includes('only share') ||
        promptText.includes('skip') ||
        promptText.includes('helps us') ||
        promptText.includes('many ') ||
        promptText.includes('comfortable')
      if (!explainsRationale) {
        findings.push({
          severity: SEVERITY_FOR_SENSITIVE_NO_RATIONALE,
          category: 'sensitive_no_rationale',
          branch,
          question_id: node.question_id,
          title: `Sensitive question "${node.question_id}" has no rationale text`,
          description: `Sensitive questions must explain why we're asking and that the answer is optional. The current prompt does neither.`,
          recommended_fix: `Update the prompt to explain why the answer matters and to mark it optional.`,
          evidence: { branch, question_id: node.question_id, prompt: fmEntry?.prompt },
        })
      }

      if (!Array.isArray(node.answer_modes) || !node.answer_modes.includes('skip')) {
        findings.push({
          severity: SEVERITY_FOR_MISSING_SKIP_PATH,
          category: 'sensitive_not_skippable',
          branch,
          question_id: node.question_id,
          title: `Sensitive question "${node.question_id}" cannot be skipped`,
          description: `Every sensitive question must offer a skip and "I don't know" path.`,
          recommended_fix: `Ensure the question node includes "skip" and "i_dont_know" in answer_modes.`,
          evidence: { branch, question_id: node.question_id, answer_modes: node.answer_modes },
        })
      }
    }
  }

  // ── 6. Sensitive questions defined in the contract that aren't sensitive in
  //       the field map (drift detection) ─────────────────────────────────────
  for (const branch of SUPPORTED_BRANCHES) {
    const expected = new Set(sensitiveFieldsForBranch(branch))
    for (const node of walkOnboarding({ branch, pace: 'keep_asking', tree })) {
      const fm = FIELD_MAP_BY_ID[node.question_id]
      if (!fm) continue
      if (expected.has(fm.intake_field) && fm.sensitive !== true) {
        findings.push({
          severity: FINDING_SEVERITY.MEDIUM,
          category: 'sensitive_flag_drift',
          branch,
          question_id: node.question_id,
          title: `Question "${node.question_id}" should be flagged sensitive`,
          description: `Contract marks "${fm.intake_field}" as sensitive in the ${branch} branch but the field map does not.`,
          recommended_fix: `Set sensitive: true in the field map entry.`,
          evidence: { branch, question_id: node.question_id, intake_field: fm.intake_field },
        })
      }
    }
  }

  // ── 7. Skip / "I don't know" path coverage on non-identity nodes ───────────
  for (const branch of SUPPORTED_BRANCHES) {
    for (const node of walkOnboarding({ branch, pace: 'keep_asking', tree })) {
      if (node.question_id === 'universal.profile_type' || node.question_id === 'universal.profile_name') {
        // identity questions are intentionally not skippable
        continue
      }
      if (!Array.isArray(node.answer_modes) || !node.answer_modes.includes('skip') || !node.answer_modes.includes('i_dont_know')) {
        findings.push({
          severity: SEVERITY_FOR_MISSING_SKIP_PATH,
          category: 'missing_skip_path',
          branch,
          question_id: node.question_id,
          title: `Question "${node.question_id}" lacks a skip / "I don't know" path`,
          description: `Non-identity questions must always be skippable so users are never trapped.`,
          recommended_fix: `Add "skip" and "i_dont_know" to the question's answer_modes.`,
          evidence: { branch, question_id: node.question_id, answer_modes: node.answer_modes },
        })
      }
    }
  }

  const coverage = {
    universal: {
      total: UNIVERSAL_REQUIRED_FIELDS.length,
      covered: UNIVERSAL_REQUIRED_FIELDS.length - universalMissing.length,
      missing: universalMissing,
    },
    branches: branchCoverage,
  }

  return {
    findings,
    coverage,
    fingerprint: fingerprintTree(tree),
  }
}

/**
 * Convenience: detect questions that are ASKED in a branch but don't appear
 * in either required or recommended for that branch in the contract — i.e.
 * "irrelevant" questions for the branch.
 */
export function findIrrelevantQuestions({
  contract = ANYA_ONBOARDING_INTAKE_CONTRACT,
  tree = ANYA_ONBOARDING_QUESTION_TREE,
} = {}) {
  const findings = []
  for (const branch of SUPPORTED_BRANCHES) {
    const branchContract = contract.branches[branch]
    if (!branchContract) continue
    const allowed = new Set([
      ...UNIVERSAL_REQUIRED_FIELDS,
      ...(contract.universal?.recommended_fields || []),
      ...branchContract.required_fields,
      ...branchContract.recommended_fields,
    ])
    for (const node of walkOnboarding({ branch, pace: 'keep_asking', tree })) {
      if (!node.intake_field) continue
      if (!allowed.has(node.intake_field)) {
        findings.push({
          severity: FINDING_SEVERITY.LOW,
          category: 'irrelevant_question',
          branch,
          question_id: node.question_id,
          title: `Question "${node.question_id}" not in contract for ${branch}`,
          description: `The intake contract for ${branch} does not list "${node.intake_field}" as required or recommended.`,
          recommended_fix: `Either add the field to the contract or remove the question from the branch.`,
          evidence: { branch, intake_field: node.intake_field },
        })
      }
    }
  }
  return findings
}
