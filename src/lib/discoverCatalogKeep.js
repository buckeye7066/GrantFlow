/**
 * Discover catalog display keep rules.
 *
 * Backend ACCEPT and directory/referral rows must never be re-dropped by the
 * client slider. "Found but not displayed" is a bug, not a UX choice.
 */

export function isDirectoryDiscoverRow(opp) {
  return Boolean(
    opp?.is_directory ||
      opp?.is_directory_resource ||
      ['DIRECTORY', 'REFERRAL', 'SCHOOL_PORTAL', 'PAST_AWARD_INTEL'].includes(
        String(opp?.opportunity_kind ?? '').toUpperCase(),
      ),
  )
}

/**
 * @param {object} opp
 * @param {number} minScoreFloor
 * @param {boolean} recoveryApplied
 * @returns {boolean}
 */
export function keepDiscoverCatalogRow(opp, minScoreFloor, recoveryApplied) {
  const decision = String(opp?.match_decision ?? opp?.decision ?? '').trim().toUpperCase()
  if (decision === 'ACCEPT') return true
  if (isDirectoryDiscoverRow(opp)) return true
  const score = Number(opp?.match_score ?? opp?.match ?? -Infinity)
  if (Number.isFinite(score) && score >= minScoreFloor) return true
  return Boolean(
    recoveryApplied &&
      (opp?.threshold_relaxed || opp?.eligibility_relaxed || opp?.geo_expanded),
  )
}
