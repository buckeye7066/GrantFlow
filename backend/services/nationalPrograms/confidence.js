const REQUIRED_FIELDS_CLIENT = [
  'program_name',
  'funding_track',
  'jurisdiction',
  'administering_agency',
  'program_type',
  'eligible_population',
  'covered_services',
  'application_method',
  'source_url',
]

const REQUIRED_FIELDS_PROVIDER = [
  'program_name',
  'funding_track',
  'jurisdiction',
  'administering_agency',
  'program_type',
  'eligible_population',
  'covered_services',
  'provider_requirements',
  'application_method',
  'source_url',
]

function fieldFilled(value) {
  if (value == null) return false
  if (typeof value === 'string') return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.keys(value).length > 0
  return true
}

export function computeConfidence(track, program) {
  const fields = track === 'PROVIDER' ? REQUIRED_FIELDS_PROVIDER : REQUIRED_FIELDS_CLIENT
  const filled = fields.reduce((acc, key) => acc + (fieldFilled(program && program[key]) ? 1 : 0), 0)
  const base = fields.length > 0 ? filled / fields.length : 0

  // Boost if we have a plausible funding amounts structure
  const amountsBoost = fieldFilled(program && program.funding_amounts) ? 0.05 : 0

  // Penalize if too many fields are unknown-ish placeholders
  const placeholders = ['unknown', 'n/a', 'na', 'tbd', 'none']
  const placeholderPenalty = Object.values(program || {}).some((v) => {
    if (typeof v !== 'string') return false
    return placeholders.includes(v.trim().toLowerCase())
  })
    ? 0.05
    : 0

  return Math.max(0, Math.min(1, base + amountsBoost - placeholderPenalty))
}

