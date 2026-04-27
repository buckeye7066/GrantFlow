const HOUSEHOLD_EVIDENCE = /\b(dependent child|household (?:member )?receives|parent gets|parent receives|child of|spouse receives)\b/i
const BENEFIT_BASES = ['medicaid', 'medicare', 'ssi', 'ssdi', 'snap', 'tanf', 'section8']

function evidenceFor(payload, key) {
  const evidence = payload?.evidence
  if (evidence && typeof evidence === 'object' && evidence[key]) return String(evidence[key])
  return String(payload?.[`${key}_evidence`] ?? payload?.supporting_evidence ?? payload?.evidence_text ?? '')
}

function householdTargetFor(key) {
  for (const base of BENEFIT_BASES) {
    if (key === `${base}_recipient_self` || key === `${base}_recipient`) return `${base}_recipient_household`
    if (base === 'medicaid' && key === 'medicaid_enrolled') return 'medicaid_recipient_household'
    if (base === 'section8' && key === 'section8_housing') return 'section8_recipient_household'
  }
  return null
}

function selfTargetFor(key) {
  if (key === 'medicaid_enrolled') return 'medicaid_recipient_self'
  if (key === 'section8_housing') return 'section8_recipient_self'
  if (key.endsWith('_recipient')) return `${key}_self`
  return key
}

function isHighSchoolProfile(profile, sections = {}) {
  const primaryType = String(profile?.primary_type || profile?.primaryType || '').toLowerCase()
  const highestLevel = String(sections?.education?.highest_level || '').toLowerCase()
  return primaryType === 'high_school_student' || highestLevel.includes('high_school') || highestLevel.includes('high school')
}

export function guardProfileSectionPayload(data, { profile, sections = {}, sectionKey } = {}) {
  const guarded = {}
  const rejected = []

  for (const [rawKey, value] of Object.entries(data ?? {})) {
    if (rawKey === 'evidence' || rawKey.endsWith('_evidence') || rawKey === 'supporting_evidence') continue
    const key = selfTargetFor(rawKey)
    const householdTarget = value === true ? householdTargetFor(rawKey) : null
    if (householdTarget && HOUSEHOLD_EVIDENCE.test(evidenceFor(data, rawKey))) {
      guarded[householdTarget] = true
      rejected.push({ key: rawKey, reason: 'household_evidence', routedTo: householdTarget })
      continue
    }
    guarded[key] = value
  }

  if (sectionKey === 'employment' && !guarded.current_status && isHighSchoolProfile(profile, sections)) {
    guarded.current_status = 'student'
  }

  return { data: guarded, rejected }
}
