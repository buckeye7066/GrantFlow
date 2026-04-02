import crypto from 'crypto'

const FANOUT_LOW = 0.0005
const FANOUT_HIGH = 0.02
const MAX_ITEMS_LOW = 10000

export function computeChangeDigest(fields, ts) {
  const sorted = [...fields].sort((a, b) => a.field.localeCompare(b.field))
  return crypto.createHash('sha256').update(JSON.stringify(sorted) + ts).digest('hex')
}

export function classifyProfileChange(fields) {
  let entity = false, primaryNaics = false, naicsCount = 0
  let geo = false, revenue = false

  for (const f of fields) {
    if (f.field === 'entity_type') entity = true

    if (f.field.includes('naics')) {
      naicsCount++
      if (f.field.includes('primary')) primaryNaics = true
    }

    if (f.field.includes('geo') || f.field.includes('radius')) {
      if (Math.abs(Number(f.new)) > 10 || Math.abs(Number(f.old) - Number(f.new)) > 5) geo = true
    }

    if (f.field.includes('revenue')) revenue = true
  }

  if (entity) return 'entity_type_change'
  if (geo) return 'geo_shift'
  if (revenue) return 'revenue_band_cross'

  if (naicsCount > 0) {
    if (primaryNaics || naicsCount > 1) return 'naics_major'
    return 'naics_minor'
  }

  // Detect other meaningful profile sections before returning unknown
  const DEEP_PROFILE_FIELDS = [
    'military', 'veteran', 'disability', 'housing', 'emergency',
    'education', 'family', 'caregiver', 'health', 'business'
  ]
  const isDeepChange = fields.some(f =>
    DEEP_PROFILE_FIELDS.some(key => f.field.toLowerCase().includes(key))
  )
  if (isDeepChange) return 'deep_profile_change'

  return 'unknown'
}

export function decideRevalAction({
  trigger, fanout_pct, affected_items, cost_units, daily_budget, manual_force
}) {
  let action = 'targeted_reval'

  if (manual_force) {
    action = 'full_recrawl'
  } else if (fanout_pct > FANOUT_HIGH) {
    action = 'full_recrawl'
  } else if (trigger === 'naics_minor') {
    action = 're-score'
  } else {
    if (fanout_pct <= FANOUT_LOW && affected_items <= MAX_ITEMS_LOW) action = 're-score'
    else if (fanout_pct <= FANOUT_HIGH) action = 'targeted_reval'
    else action = 'full_recrawl'
  }

  if (action === 'full_recrawl' && cost_units > 10 * daily_budget) {
    return { block: true, reason: 'cost_guardrail' }
  }

  return { block: false, action, reason: trigger }
}

export function mapActionToCrawlerJob(action) {
  if (action === 're-score') return 'profile_enrichment'
  if (action === 'targeted_reval') return 'targeted_profile_crawl'
  return 'comprehensive'
}

export function estimateCompletion(action, startIso) {
  const base = new Date(startIso).getTime()
  if (action === 're-score') return new Date(base + 5 * 60 * 1000).toISOString()
  if (action === 'targeted_reval') return new Date(base + 60 * 60 * 1000).toISOString()
  return new Date(base + 24 * 60 * 60 * 1000).toISOString()
}
