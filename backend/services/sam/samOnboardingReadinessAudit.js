/**
 * Sam — onboarding readiness audit.
 *
 * After an onboarding session finishes, the resulting profile should:
 *   - have a Profile Readiness Score >= READINESS_FLOOR
 *   - cover the universal required intake fields
 *   - cover the branch-required fields
 *
 * If not, Sam emits findings explaining why Robert won't be able to
 * search effectively for that profile.
 *
 * Reads the existing detailed-readiness service when present (the
 * `computeDetailedReadiness` export added in the readiness-and-funding-
 * library PR). When unavailable — for example on a pre-#526 branch — we
 * degrade gracefully and return a "not_installed" payload rather than
 * blowing up.
 */

import { withProfileScope } from '../../middleware/profileContext.js'
import { FINDING_SEVERITY } from './samOnboardingQuestionContract.js'

const READINESS_FLOOR = 50
const ROBERT_SEARCH_FLOOR = 60 // identity + location + at least one need

/**
 * Lazy resolver so the module can load even if the detailed-readiness
 * function isn't present in a particular branch.
 */
async function resolveReadiness(override) {
  if (typeof override === 'function') return override
  try {
    const mod = await import('../profileReadinessService.js')
    if (typeof mod.computeDetailedReadiness === 'function') return mod.computeDetailedReadiness
  } catch {
    // ignore
  }
  return null
}

/**
 * Audit one finished onboarding session — given the resulting profile id.
 */
export async function auditCompletedOnboarding(db, profileId, options = {}) {
  const { branch = null, computeDetailedReadiness } = options
  const findings = []
  const compute = await resolveReadiness(computeDetailedReadiness)

  if (!db || !profileId) {
    return {
      profile_id: profileId,
      branch,
      readiness: null,
      robert_search_readiness: null,
      findings,
      readiness_service_available: Boolean(compute),
    }
  }

  if (!compute) {
    return {
      profile_id: profileId,
      branch,
      readiness: null,
      robert_search_readiness: null,
      findings: [
        {
          severity: FINDING_SEVERITY.INFO,
          category: 'readiness_service_unavailable',
          branch,
          question_id: null,
          title: 'Detailed readiness service is not installed yet',
          description:
            'Sam can audit when the computeDetailedReadiness export becomes available (added by the profile-readiness PR).',
          recommended_fix: 'Merge the readiness service PR or pass a custom compute function.',
          evidence: {},
        },
      ],
      readiness_service_available: false,
    }
  }

  const readiness = await withProfileScope({ bypass: true }, () => compute(db, profileId))

  if (!readiness) {
    findings.push({
      severity: FINDING_SEVERITY.CRITICAL,
      category: 'no_profile_after_onboarding',
      branch,
      question_id: null,
      title: `Profile ${profileId} is unavailable after onboarding`,
      description: `Onboarding completed but no profile or readiness data is reachable.`,
      recommended_fix: `Check that the conversation engine is calling the profile-create / profile-update path on completion.`,
      evidence: { profile_id: profileId },
    })
    return { profile_id: profileId, branch, readiness, robert_search_readiness: 0, findings, readiness_service_available: true }
  }

  const score = Number(readiness.readiness_score || 0)
  if (score < READINESS_FLOOR) {
    findings.push({
      severity: FINDING_SEVERITY.HIGH,
      category: 'readiness_too_low_after_onboarding',
      branch,
      question_id: null,
      title: `Profile readiness ${score}/100 after onboarding`,
      description: `A completed onboarding should produce at least ${READINESS_FLOOR}/100. Robert will struggle to find good matches below that threshold.`,
      recommended_fix: `Ensure required questions are actually answered (not just skipped) before marking onboarding complete.`,
      evidence: { profile_id: profileId, score, missing_items: readiness.missing_items },
    })
  }

  const required = new Set(['identity', 'location', 'funding_needs'])
  const robertEarned = (readiness.categories || [])
    .filter((c) => required.has(c.key))
    .reduce((s, c) => s + (Number(c.earned) || 0), 0)
  const robertMax = ((readiness.categories || [])
    .filter((c) => required.has(c.key))
    .reduce((s, c) => s + (Number(c.weight) || 0), 0)) || 1
  const robert_search_readiness = Math.round((robertEarned / robertMax) * 100)

  if (robert_search_readiness < ROBERT_SEARCH_FLOOR) {
    findings.push({
      severity: FINDING_SEVERITY.HIGH,
      category: 'robert_search_readiness_too_low',
      branch,
      question_id: null,
      title: `Robert search readiness ${robert_search_readiness}/100`,
      description: `Identity, location, and funding-needs categories are too thin for effective search.`,
      recommended_fix: `Confirm onboarding actually elicits applicant type, location, and at least one funding need before completing.`,
      evidence: {
        profile_id: profileId,
        robert_search_readiness,
        categories: (readiness.categories || []).filter((c) => required.has(c.key)),
      },
    })
  }

  return {
    profile_id: profileId,
    branch,
    readiness,
    robert_search_readiness,
    findings,
    readiness_service_available: true,
  }
}

/**
 * Aggregate audit across N recently-completed onboardings.
 */
export async function auditRecentCompletions(db, profileIds = [], options = {}) {
  const { branchFor = () => null, computeDetailedReadiness } = options
  const summaries = []
  for (const id of profileIds) {
    const r = await auditCompletedOnboarding(db, id, { branch: branchFor(id), computeDetailedReadiness })
    summaries.push(r)
  }
  const findings = summaries.flatMap((s) => s.findings)
  const scored = summaries.filter((s) => s.readiness)
  const avg_readiness = scored.length
    ? Math.round(scored.reduce((s, x) => s + Number(x.readiness?.readiness_score || 0), 0) / scored.length)
    : null
  const avg_robert_readiness = scored.length
    ? Math.round(scored.reduce((s, x) => s + Number(x.robert_search_readiness || 0), 0) / scored.length)
    : null
  return {
    audited: profileIds.length,
    summaries,
    avg_readiness,
    avg_robert_readiness,
    findings,
  }
}

export const __exposed = { READINESS_FLOOR, ROBERT_SEARCH_FLOOR, resolveReadiness }
