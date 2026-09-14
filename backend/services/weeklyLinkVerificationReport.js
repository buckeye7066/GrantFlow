const PASS_STAT_KEYS = Object.freeze([
  'checked', 'ok', 'redirect', 'suspicious', 'broken', 'skipped', 'unverified',
  'deactivated', 'expired', 'quarantined', 'restored',
])

export function addLinkVerificationPassStats(total = {}, pass = {}) {
  return Object.fromEntries(PASS_STAT_KEYS.map(key => [
    key,
    Number(total[key] || 0) + Number(pass[key] || 0),
  ]))
}

/**
 * Keep the operator email aligned with the release gate. The raw status census
 * includes hidden, inactive, expired, and retired history, so it must never be
 * presented as the actionable backlog by itself.
 */
export function buildWeeklyLinkVerificationReport({ weekKey, passStats, byStatus, releaseCatalog }) {
  const visible = releaseCatalog || {}
  const direct = visible.visible_direct || {}
  const pointer = visible.visible_pointer || {}
  return [
    `GrantFlow weekly link verification — week of ${weekKey} (America/New_York)`,
    '',
    `This pass: ${JSON.stringify(passStats)}.`,
    `Visible catalog freshness (the /readyz release gate): ${visible.verified_fresh ?? 0}/${visible.denominator_total ?? 0} (${visible.verified_pct ?? 0}%; target ${visible.target_pct ?? 95}%), ${visible.unverified_or_stale ?? 0} unverified or stale.`,
    `Visible direct: ${direct.verified_fresh ?? 0}/${direct.total ?? 0}; visible pointers: ${pointer.verified_fresh ?? 0}/${pointer.total ?? 0}.`,
    `All-row status census (includes inactive, hidden, expired, and retired history; not the actionable backlog): ${JSON.stringify(byStatus)}.`,
    '',
    'The recurring verifier runs at least every 3h between weekly passes (environment overrides may make it faster).',
  ].join('\n')
}

