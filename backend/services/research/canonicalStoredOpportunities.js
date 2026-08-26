const MAX_OPPORTUNITIES = 2_000
const QUERY_BATCH_SIZE = 400

function parsedSection(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  try {
    const parsed = JSON.parse(String(value || '{}'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export async function loadStoredResearchProfile(db, profileId) {
  const [profile, sectionRows] = await Promise.all([
    db.prepare('SELECT * FROM profiles WHERE id = ? LIMIT 1').get(profileId),
    db.prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?').all(profileId),
  ])
  if (!profile) {
    const error = new Error('Profile not found')
    error.status = 404
    throw error
  }
  const sections = Object.fromEntries((sectionRows || []).map((row) => [
    String(row.section_key),
    parsedSection(row.data),
  ]))
  return {
    ...profile,
    sections,
    research_topics: sections.research?.topics
      ?? sections.professional?.research_topics
      ?? profile.research_topics,
    research_methods: sections.research?.methods
      ?? sections.professional?.research_methods
      ?? profile.research_methods,
    career_stage: sections.professional?.career_stage ?? profile.career_stage,
  }
}

async function storedDecisionColumn(db) {
  const dialect = db?.dialect || 'sqlite'
  const rows = dialect === 'postgres'
    ? await db.prepare(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'profile_opportunity_matches'`,
    ).all()
    : await db.prepare('PRAGMA table_info(profile_opportunity_matches)').all()
  const names = new Set((rows || []).map((row) => String(row.column_name ?? row.name)))
  if (names.has('match_decision')) return 'match_decision'
  if (names.has('decision')) return 'decision'
  throw new Error('profile_opportunity_matches has no canonical decision column')
}

export async function loadCanonicalStoredOpportunities(db, { profileId, opportunityIds = null }) {
  const decisionColumn = await storedDecisionColumn(db)
  const select = `SELECT fo.*, m.${decisionColumn} AS canonical_decision
      FROM profile_opportunity_matches m
      JOIN funding_opportunities fo ON fo.id = m.opportunity_id
     WHERE m.profile_id = ?`
  let rows = []
  if (opportunityIds === null) {
    rows = await db.prepare(
      `${select} ORDER BY m.match_score DESC, fo.id LIMIT ?`, // audit:allow dynamic-sql -- selected column comes from a fixed allowlist
    ).all(profileId, MAX_OPPORTUNITIES)
  } else {
    for (let offset = 0; offset < opportunityIds.length; offset += QUERY_BATCH_SIZE) {
      const batch = opportunityIds.slice(offset, offset + QUERY_BATCH_SIZE)
      if (batch.length === 0) continue
      const placeholders = batch.map(() => '?').join(', ')
      const found = await db.prepare(
        `${select} AND fo.id IN (${placeholders})`, // audit:allow dynamic-sql -- placeholders only; ids remain bound parameters
      ).all(profileId, ...batch)
      rows.push(...(found || []))
    }
  }

  const activeRows = (rows || []).filter((row) => {
    const active = row?.is_active === undefined || row?.is_active === null || Number(row.is_active) !== 0
    const hidden = row?.is_hidden !== undefined && row?.is_hidden !== null && Number(row.is_hidden) !== 0
    return active && !hidden
  })
  const byId = new Map(activeRows.map((row) => [String(row.id), row]))
  const ordered = opportunityIds === null
    ? activeRows
    : opportunityIds.map((id) => byId.get(id)).filter(Boolean)
  const unavailableIds = opportunityIds === null
    ? []
    : opportunityIds.filter((id) => !byId.has(id))
  return { opportunities: ordered, unavailableIds }
}

export default loadCanonicalStoredOpportunities
