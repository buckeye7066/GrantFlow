/**
 * Canonical matching engine for GrantFlow.
 *
 * Supports two call conventions (auto-detected by first-arg type):
 *
 * A) Profile-first (routes, tests):
 *    calculateMatchScore(profile, opportunity)
 *    Returns { score: number, reasons: string[], matchedSignals: string[] }
 *
 * B) Legacy crawler shim:
 *    calculateMatchScore(opportunityText: string, effectiveSignals: { keywordSet: Set })
 *    Returns { score: number, reasons: string[], matchedSignals: string[] }
 */

function safeParseJson(value) {
  if (Array.isArray(value)) return value
  try {
    const parsed = JSON.parse(value || '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

function scoreProfileVsOpportunity(profile, opp) {
  let score = 0
  const reasons = []
  const matchedSignals = []

  const profileState = profile?.state || profile?.signals?.location?.state || null
  const hasKnownLocation = Boolean(profileState && String(profileState).trim().length >= 2)

  const oppIsNational = Boolean(opp?.is_national)
  const oppState = String(opp?.state || '').trim().toUpperCase()
  const profileStateNorm = String(profileState || '').trim().toUpperCase()

  if (hasKnownLocation) {
    if (oppIsNational || oppState === 'NATIONWIDE' || oppState === 'ALL') {
      score += 8
      reasons.push('National eligibility')
      matchedSignals.push('geo:national')
    } else if (oppState && oppState === profileStateNorm) {
      score += 10
      reasons.push(`State match: ${profileStateNorm}`)
      matchedSignals.push(`geo:${profileStateNorm}`)
    } else if (oppState && oppState !== profileStateNorm) {
      score -= 5
    }
  } else {
    score -= 5  // unknown location penalty
  }

  const primaryType = String(profile?.primary_type || '').toLowerCase().trim()
  const eligibilityBullets = safeParseJson(opp?.eligibility_bullets).map((s) => String(s).toLowerCase())
  if (primaryType && eligibilityBullets.length > 0) {
    const typeMatches = eligibilityBullets.some(
      (b) => b.includes(primaryType) || primaryType.includes(b.replace(/_/g, ' ')),
    )
    if (typeMatches) {
      score += 10
      reasons.push(`Eligibility match: ${primaryType}`)
      matchedSignals.push(`type:${primaryType}`)
    }
  }

  const keywordSet = profile?.signals?.keywordSet instanceof Set ? profile.signals.keywordSet : new Set()
  const oppText = [opp?.title, opp?.description, ...safeParseJson(opp?.keywords)].filter(Boolean).join(' ').toLowerCase()
  const oppCategories = safeParseJson(opp?.categories).map((c) => String(c).toLowerCase())

  for (const kw of keywordSet) {
    const kwNorm = String(kw).toLowerCase().trim()
    if (!kwNorm || kwNorm.length < 3) continue
    try {
      const escaped = kwNorm.replace(/[.*+?^${}()|[\\]\]/g, '\$&')
      const regex = new RegExp(`\b${escaped}\b`, 'i')
      if (regex.test(oppText)) {
        matchedSignals.push(`kw:${kwNorm}`)
        score += 2
        if (!reasons.includes('Keyword match')) reasons.push('Keyword match')
      }
    } catch { /* skip bad regex */ }
  }

  const profileCategories = Array.isArray(profile?.signals?.categories)
    ? profile.signals.categories.map((c) => String(c).toLowerCase())
    : []

  for (const pc of profileCategories) {
    if (oppCategories.some((oc) => oc.includes(pc) || pc.includes(oc))) {
      score += 5
      reasons.push(`Category match: ${pc}`)
      matchedSignals.push(`cat:${pc}`)
    }
  }

  return { score: Math.max(0, Math.min(100, score)), reasons, matchedSignals }
}

function scoreTextVsSignals(opportunityText, effectiveSignals) {
  const matchedSignals = []
  const reasons = []
  let score = 0
  const keywordSet = effectiveSignals?.keywordSet instanceof Set ? effectiveSignals.keywordSet : new Set()
  const text = String(opportunityText || '').toLowerCase()

  for (const keyword of keywordSet) {
    const kwNorm = String(keyword).toLowerCase().trim()
    if (!kwNorm || kwNorm.length < 3) continue
    try {
      const escaped = kwNorm.replace(/[.*+?^${}()|[\\]\]/g, '\$&')
      const regex = new RegExp(`\b${escaped}\b`, 'g')
      if (regex.test(text)) {
        matchedSignals.push(`kw:${kwNorm}`)
        score += 2
        if (!reasons.includes('Keyword match')) reasons.push('Keyword match')
      }
    } catch { /* skip */ }
  }

  return { score: Math.max(0, Math.min(100, score)), reasons, matchedSignals }
}

export function calculateMatchScore(profileOrText, oppOrSignals) {
  if (typeof profileOrText === 'string') {
    return scoreTextVsSignals(profileOrText, oppOrSignals)
  }
  return scoreProfileVsOpportunity(profileOrText, oppOrSignals)
}

export default { calculateMatchScore }