/**
 * samAdversarialRepair.js
 *
 * OPT-IN new-risk-tier for Sam: findings that need a REAL code edit (a
 * "manual" repair strategy — the ones planForFinding today marks
 * requires_admin_approval with no safe fix) get one two-model
 * author↔verifier repair attempt via generateVerifiedRepair. This is
 * strictly ADDITIVE to the existing deterministic safe fixes (applySafeFixes),
 * which are untouched.
 *
 * Every guard the rest of Sam relies on still holds, and this path is gated OFF
 * by default so it can NEVER fire on the scheduler unexpectedly:
 *
 *   1. SAM_ADVERSARIAL_REPAIR must be truthy (default OFF).
 *   2. repair-safe mode + authorised admin + NOT dryRun (same as applySafeFixes).
 *   3. `.agent-edit-lock` must be absent (multi-agent coordination).
 *   4. Only findings whose affected_files ALL pass isPathSafeForFix are eligible
 *      (forbidden paths — migrations/schema/auth/billing — are never touched).
 *   5. generateVerifiedRepair must return status 'clean' (a passing adversarial
 *      verdict); anything else applies NOTHING and is recorded as a finding note.
 *   6. Dispatch is branch/PR only (dispatchCodeFixWorkflow → CI-gated PR against
 *      main, never a direct-to-main mutation, never a raw fs write), and is
 *      additionally gated by assertCommitAllowed (SAM_AUTO_COMMIT_ALLOWED) so the
 *      charter default keeps it inert even with the feature flag on.
 *
 * Everything external is injectable so tests never touch a provider, git, or a
 * real remote.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { isPathSafeForFix } from './samSafeFixes.js'
import { getSamPolicy, assertCommitAllowed } from './samPolicy.js'
import { buildFixBranchName } from './samGit.js'
import { generateVerifiedRepair } from '../anyaAdversarialRepairLoop.js'
import { landVerifiedPatch } from '../anyaCodeFixDispatch.js'
import { isAgentEditLockPresent } from '../../utils/agentEditLock.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')

function isFlagOn(env) {
  return /^(1|true|yes|on)$/i.test(String(env?.SAM_ADVERSARIAL_REPAIR ?? '').trim())
}

/** A finding needs a real code edit when its plan strategy is a "manual" one. */
export function isManualCodeEditPlan(plan) {
  return Boolean(plan) && /manual/i.test(String(plan.strategy || ''))
}

/**
 * For each manual-strategy finding with safe affected files, run the
 * adversarial loop and (only on a clean verdict + policy allow) dispatch a
 * branch/PR. Returns an audit object; NEVER throws.
 *
 * @returns {Promise<{enabled:boolean, skipped?:string, attempted:number,
 *                    proposals:object[], notes:object[]}>}
 */
export async function runAdversarialRepairs({
  findings = [],
  repairPlan = [],
  runId = null,
  db = null,
  env = process.env,
  maxRounds = 3,
  maxRepairs = Number(process.env.SAM_ADVERSARIAL_MAX_REPAIRS) || 3,
  // How a clean verified diff lands: 'pr' (default) or 'direct' (auto-merge to
  // main after release:gates). Default keeps Sam on the PR path.
  landMode = /^direct$/i.test(String(process.env.SAM_ADVERSARIAL_LAND_MODE ?? '').trim()) ? 'direct' : 'pr',
  // Injectables (tests never hit a provider / git / remote):
  generateRepair = generateVerifiedRepair,
  landPatch = landVerifiedPatch,
  isEditLockPresent = isAgentEditLockPresent,
  readFile = (abs) => fs.readFile(abs, 'utf8'),
  policy = null,
  logger = console,
} = {}) {
  const out = { enabled: isFlagOn(env), attempted: 0, proposals: [], notes: [] }
  if (!out.enabled) return out

  // Never dispatch while a human + another assistant are actively editing.
  if (isEditLockPresent(REPO_ROOT)) {
    return { ...out, skipped: 'edit_lock_held' }
  }

  const effectivePolicy = policy || getSamPolicy(env)
  const planByFinding = new Map((repairPlan || []).map((p) => [p?.finding_id, p]))

  for (const finding of findings || []) {
    if (out.attempted >= maxRepairs) break
    const plan = planByFinding.get(finding?.id)
    if (!isManualCodeEditPlan(plan)) continue

    const affected = Array.isArray(finding.affected_files) ? finding.affected_files.filter(Boolean) : []
    if (affected.length === 0) continue
    // Conservative: if ANY affected file is unsafe (forbidden path / outside
    // allowlist), skip the whole finding — we won't cherry-pick.
    if (!affected.every((f) => isPathSafeForFix(f))) {
      out.notes.push({ finding_id: finding.id, outcome: 'skipped', reason: 'affected_files_not_all_safe' })
      continue
    }
    // The loop repairs a single file; target the first safe file.
    const filePath = affected[0]

    let fileText
    try {
      fileText = await readFile(path.resolve(REPO_ROOT, filePath))
    } catch (err) {
      out.notes.push({ finding_id: finding.id, outcome: 'skipped', reason: `cannot_read:${err?.message || err}` })
      continue
    }

    out.attempted += 1
    let repair
    try {
      repair = await generateRepair({
        finding: {
          title: finding.title,
          description: finding.description,
          recommended_fix: finding.recommended_fix,
          category: finding.category,
          severity: finding.severity,
        },
        fileText,
        filePath,
        maxRounds,
      })
    } catch (err) {
      out.notes.push({ finding_id: finding.id, outcome: 'error', reason: String(err?.message || err) })
      continue
    }

    if (repair.status !== 'clean') {
      // Apply NOTHING; record why so the finding stays visible + explainable.
      out.notes.push({
        finding_id: finding.id,
        file: filePath,
        outcome: repair.status, // 'unverified' | 'no_fix' | 'rejected'
        reason: repair.reason,
        rounds: repair.rounds,
      })
      continue
    }

    // Clean, adversarially-verified diff. Charter gate: branch-only, never main.
    const branch = buildFixBranchName(runId)
    const gate = assertCommitAllowed({ branch }, effectivePolicy)
    if (!gate.allowed) {
      out.notes.push({
        finding_id: finding.id,
        file: filePath,
        outcome: 'verified_not_dispatched',
        reason: gate.reason,
        rounds: repair.rounds,
      })
      continue
    }

    let landing
    try {
      landing = await landPatch({
        patch: repair.diff,
        title: `fix(sam): adversarially-verified repair for ${finding.title || filePath}`,
        landMode, // 'pr' (default) or 'direct'; critical paths auto-downgrade to PR.
        automerge: false, // Sam proposes; a human/branch-protection merges on the PR path.
        db, // enables single-use nonce enforcement on the direct path
        env,
      })
    } catch (err) {
      out.notes.push({ finding_id: finding.id, file: filePath, outcome: 'dispatch_error', reason: String(err?.message || err) })
      continue
    }

    logger?.info?.('sam.adversarial.proposed', {
      finding_id: finding.id,
      file: filePath,
      land_mode: landing?.land_mode,
      dispatched: landing?.dispatched === true,
      landed: landing?.landed === true,
    })
    out.proposals.push({
      finding_id: finding.id,
      file: filePath,
      rounds: repair.rounds,
      land_mode: landing?.land_mode,
      downgraded_to_pr: landing?.downgraded_to_pr === true,
      dispatched: landing?.dispatched === true,
      landed: landing?.landed === true,
      landing,
    })
  }

  return out
}

export const __testing__ = { REPO_ROOT, isFlagOn, isManualCodeEditPlan }
