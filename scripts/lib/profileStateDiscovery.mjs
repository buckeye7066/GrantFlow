const STATE_NAME_TO_ABBR = {
  ALABAMA: 'AL',
  ALASKA: 'AK',
  ARIZONA: 'AZ',
  ARKANSAS: 'AR',
  CALIFORNIA: 'CA',
  COLORADO: 'CO',
  CONNECTICUT: 'CT',
  DELAWARE: 'DE',
  FLORIDA: 'FL',
  GEORGIA: 'GA',
  HAWAII: 'HI',
  IDAHO: 'ID',
  ILLINOIS: 'IL',
  INDIANA: 'IN',
  IOWA: 'IA',
  KANSAS: 'KS',
  KENTUCKY: 'KY',
  LOUISIANA: 'LA',
  MAINE: 'ME',
  MARYLAND: 'MD',
  MASSACHUSETTS: 'MA',
  MICHIGAN: 'MI',
  MINNESOTA: 'MN',
  MISSISSIPPI: 'MS',
  MISSOURI: 'MO',
  MONTANA: 'MT',
  NEBRASKA: 'NE',
  NEVADA: 'NV',
  'NEW HAMPSHIRE': 'NH',
  'NEW JERSEY': 'NJ',
  'NEW MEXICO': 'NM',
  'NEW YORK': 'NY',
  'NORTH CAROLINA': 'NC',
  'NORTH DAKOTA': 'ND',
  OHIO: 'OH',
  OKLAHOMA: 'OK',
  OREGON: 'OR',
  PENNSYLVANIA: 'PA',
  'RHODE ISLAND': 'RI',
  'SOUTH CAROLINA': 'SC',
  'SOUTH DAKOTA': 'SD',
  TENNESSEE: 'TN',
  TEXAS: 'TX',
  UTAH: 'UT',
  VERMONT: 'VT',
  VIRGINIA: 'VA',
  WASHINGTON: 'WA',
  'WEST VIRGINIA': 'WV',
  WISCONSIN: 'WI',
  WYOMING: 'WY',
  'DISTRICT OF COLUMBIA': 'DC',
}

const VALID_STATE_CODES = new Set(Object.values(STATE_NAME_TO_ABBR))
const STATE_KEYS = new Set([
  'state',
  'residencestate',
  'residence_state',
  'homestate',
  'home_state',
  'mailingstate',
  'mailing_state',
  'physicalstate',
  'physical_state',
  'currentstate',
  'current_state',
  'addressstate',
  'address_state',
  'studentstate',
  'student_state',
  'orgstate',
  'organizationstate',
  'organization_state',
])

function normalizeState(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const upper = trimmed.toUpperCase()
  if (VALID_STATE_CODES.has(upper)) return upper
  return STATE_NAME_TO_ABBR[upper] ?? null
}

function collectStatesFromValue(value, keyHint, sink) {
  if ((value === null || value === undefined)) return

  if (Array.isArray(value)) {
    value.forEach(entry => collectStatesFromValue(entry, keyHint, sink))
    return
  }

  if (typeof value === 'string') {
    const normalized = normalizeState(value)
    if (normalized && (!keyHint || STATE_KEYS.has(keyHint))) sink.add(normalized)
    return
  }

  if (typeof value !== 'object') return

  Object.entries(value).forEach(([key, nestedValue]) => {
    const normalizedKey = String(key).replace(/[^a-z]/gi, '').toLowerCase()
    const nextKeyHint = STATE_KEYS.has(normalizedKey) ? normalizedKey : null
    collectStatesFromValue(nestedValue, nextKeyHint, sink)
  })
}

function collectProfileSectionStates(db, profileId) {
  const rows = db.prepare('SELECT data FROM profile_sections WHERE profile_id = ?').all(profileId)
  const states = new Set()

  rows.forEach(row => {
    if (!row?.data) return
    try {
      const parsed = JSON.parse(row.data)
      collectStatesFromValue(parsed, null, states)
    } catch {
      // Ignore malformed profile section payloads.
    }
  })

  return states
}

export function getProfileResidentStates(db) {
  const profiles = db.prepare(`
    SELECT p.id, p.display_name, o.state AS organization_state
    FROM profiles p
    LEFT JOIN organizations o ON o.id = p.organization_id
    WHERE COALESCE(p.status, 'active') = 'active'
    ORDER BY p.created_at ASC
  `).all()

  const states = new Set()
  const details = []

  profiles.forEach(profile => {
    const sectionStates = collectProfileSectionStates(db, profile.id)
    const organizationState = normalizeState(profile.organization_state)

    if (sectionStates.size === 0 && organizationState) {
      sectionStates.add(organizationState)
    }

    if (sectionStates.size > 0) {
      const resolvedStates = [...sectionStates].sort()
      resolvedStates.forEach(state => states.add(state))
      details.push({
        profileId: profile.id,
        displayName: profile.display_name,
        states: resolvedStates,
      })
    }
  })

  return {
    states: [...states].sort(),
    details,
  }
}
