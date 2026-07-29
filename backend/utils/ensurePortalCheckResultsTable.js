function parseJson(value, fallback = {}) {
  if (value && typeof value === 'object') return value
  try {
    return value ? JSON.parse(String(value)) : fallback
  } catch {
    return fallback
  }
}

function normalize(value) {
  return String(value ?? '').trim().toLowerCase()
}

function numericIdentity(value) {
  if (value === null || value === undefined || value === '') return ''
  const number = Number(value)
  return Number.isFinite(number) ? String(number) : ''
}

function awardMatchesPortalResult(award = {}, row = {}, parsed = {}) {
  const rowUrl = normalize(parsed.portalUrl ?? parsed.portal_url ?? row.portal_url)
  const awardUrl = normalize(award.portal_url ?? award.portalUrl)
  const rowPortal = normalize(parsed.portalName ?? parsed.portal_name ?? row.portal_name)
  const awardPortal = normalize(award.portal_name ?? award.portalName)

  // URL identity is authoritative when both sides have one. A shared portal name
  // must never override two conflicting URLs. Name identity is the conservative
  // fallback only when at least one side lacks a URL.
  if (rowUrl && awardUrl) {
    if (rowUrl !== awardUrl) return false
  } else if (!rowPortal || !awardPortal || rowPortal !== awardPortal) {
    return false
  }

  const rowAward = normalize(parsed.awardName ?? parsed.award_name)
  const awardName = normalize(award.award_name ?? award.awardName)
  if (rowAward && awardName && rowAward !== awardName) return false

  const rowRaw = normalize(parsed.awardAmountRaw ?? parsed.award_amount_raw)
  const awardRaw = normalize(award.award_amount_raw ?? award.awardAmountRaw)
  if (rowRaw && awardRaw && rowRaw !== awardRaw) return false

  const rowAmount = numericIdentity(parsed.awardAmount ?? parsed.award_amount)
  const awardAmount = numericIdentity(award.award_amount ?? award.awardAmount)
  if (rowAmount && awardAmount && rowAmount !== awardAmount) return false

  return true
}

async function findOwnerPersistedAward(db, row, parsed) {
  let section
  try {
    section = await db
      .prepare(`SELECT data FROM profile_sections
                WHERE profile_id = ? AND section_key = 'university_applications'
                LIMIT 1`)
      .get(row.profile_id)
  } catch {
    return null
  }

  const data = parseJson(section?.data, {})
  const applications = Array.isArray(data?.applications) ? data.applications : []
  const applicationId = String(parsed?.applicationId ?? parsed?.application_id ?? '').trim()
  const scopedApplications = applicationId
    ? applications.filter((application) => String(application?.id ?? '') === applicationId)
    : applications

  const matches = []
  for (const application of scopedApplications) {
    const awards = Array.isArray(application?.imported_portal_awards)
      ? application.imported_portal_awards
      : []
    for (const award of awards) {
      if (awardMatchesPortalResult(award, row, parsed)) matches.push(award)
    }
  }

  // Never guess between multiple owner records. Ambiguity falls back to the
  // public-signal classification, preserving every owner record untouched.
  return matches.length === 1 ? matches[0] : null
}

export async function repairLegacyPublicAwardClaims(db) {
  let rows = []
  try {
    rows = await db
      .prepare(`SELECT id, profile_id, portal_name, portal_url, awards_detected, results_json
                  FROM portal_check_results
                 WHERE COALESCE(awards_detected, 0) <> 0
                    OR (results_json IS NOT NULL
                        AND results_json NOT LIKE '%"publicPortalHonestyVersion":1%')`)
      .all()
  } catch {
    return 0
  }

  let repaired = 0
  for (const row of rows || []) {
    const parsed = parseJson(row?.results_json, {})
    const ownerAward = await findOwnerPersistedAward(db, row, parsed)

    const rawAmount = parsed?.awardAmount ?? parsed?.award_amount ?? null
    const rawAmountText = parsed?.awardAmountRaw ?? parsed?.award_amount_raw ?? null
    const hasAmount = rawAmount !== null && rawAmount !== undefined && rawAmount !== ''
    const numericAmount = hasAmount && Number.isFinite(Number(rawAmount))
      ? Number(rawAmount)
      : null
    const existingSignals = parsed?.publicSignals ?? parsed?.public_signals ?? null
    const hadPublicAwardClaim =
      Number(row?.awards_detected ?? 0) !== 0 ||
      normalize(parsed?.updateType ?? parsed?.update_type) === 'scholarship_award' ||
      Boolean(parsed?.awardName ?? parsed?.award_name ?? rawAmount ?? rawAmountText)

    const publicSignals = existingSignals ?? (hadPublicAwardClaim
      ? {
          has_award_language: true,
          advertised_amount: numericAmount,
          advertised_amount_raw: rawAmountText ? String(rawAmountText) : null,
          legacy_reclassified: true,
        }
      : null)

    const next = {
      ...parsed,
      publicPortalHonestyVersion: 1,
      updateType: ownerAward ? 'owner_merged_award' : null,
      update_type: ownerAward ? 'owner_merged_award' : null,
      awardName: ownerAward?.award_name ?? ownerAward?.awardName ?? null,
      award_name: ownerAward?.award_name ?? ownerAward?.awardName ?? null,
      awardAmount: ownerAward?.award_amount ?? ownerAward?.awardAmount ?? null,
      award_amount: ownerAward?.award_amount ?? ownerAward?.awardAmount ?? null,
      awardAmountRaw: ownerAward?.award_amount_raw ?? ownerAward?.awardAmountRaw ?? null,
      award_amount_raw: ownerAward?.award_amount_raw ?? ownerAward?.awardAmountRaw ?? null,
      publicSignals,
    }

    try {
      const result = await db
        .prepare('UPDATE portal_check_results SET awards_detected = 0, results_json = ? WHERE id = ?')
        .run(JSON.stringify(next), row.id)
      repaired += Number(result?.changes ?? result?.rowCount ?? 0) || 1
    } catch {
      // A malformed historical row must never prevent startup or a status read.
    }
  }

  if (repaired > 0) {
    console.info('[portal-check] reconciled legacy public award claims', { repaired })
  }
  return repaired
}

export default async function ensurePortalCheckResultsTable(db) {
  if (!db) return

  if (db?.dialect === 'postgres') {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS portal_check_results (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        portal_name TEXT NOT NULL,
        portal_url TEXT,
        check_type TEXT DEFAULT 'scheduled',
        status TEXT DEFAULT 'completed',
        awards_detected INTEGER DEFAULT 0,
        results_json TEXT,
        checked_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_portal_check_results_profile_id ON portal_check_results(profile_id);
      CREATE INDEX IF NOT EXISTS idx_portal_check_results_checked_at ON portal_check_results(checked_at);
    `)
  } else {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS portal_check_results (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        portal_name TEXT NOT NULL,
        portal_url TEXT,
        check_type TEXT DEFAULT 'scheduled',
        status TEXT DEFAULT 'completed',
        awards_detected INTEGER DEFAULT 0,
        results_json TEXT,
        checked_at TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_portal_check_results_profile_id ON portal_check_results(profile_id);
      CREATE INDEX IF NOT EXISTS idx_portal_check_results_checked_at ON portal_check_results(checked_at);
    `)
  }

  // Called from startup self-heal and before every portal status/check operation.
  // Each row is marked after one pass; later calls touch only newly inserted rows.
  await repairLegacyPublicAwardClaims(db)
}
