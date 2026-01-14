import crypto from 'crypto'

function ensureArray(value) {
  if (!value) return []
  if (Array.isArray(value)) return value
  return [value]
}

function stableSourceIdFromOpportunity(source, opportunity) {
  const url = opportunity?.source_url ?? opportunity?.url ?? opportunity?.application_url ?? null
  const title = opportunity?.title ?? ''
  const sponsor = opportunity?.sponsor ?? ''
  const deadline = opportunity?.deadline ?? ''
  const raw = `${source}|${String(url || '').trim().toLowerCase()}|${String(title).trim().toLowerCase()}|${String(sponsor).trim().toLowerCase()}|${String(deadline).trim()}`
  // Stable, deterministic source_id so repeated crawls don't create duplicates.
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32)
}

function deriveIsNational(opportunity) {
  return (
    opportunity?.is_national === true ||
    opportunity?.is_national === 1 ||
    opportunity?.state === 'nationwide'
  )
}

function deriveRecordOrigin(opportunity) {
  const origin = opportunity?.record_origin
  if (typeof origin === 'string' && origin.length > 0) return origin
  return 'live_crawl'
}

export function upsertFundingOpportunity(db, opportunity) {
  const source = opportunity.source ?? 'crawler'
  const sourceId =
    opportunity.source_id ??
    // Many crawler datasets ship a stable `id` field; treat that as the source_id when present.
    opportunity.id ??
    stableSourceIdFromOpportunity(source, opportunity)

  // Check if record exists and if it's verified
  const existing = db
    .prepare(
      `SELECT id, last_verified_at FROM funding_opportunities WHERE source = ? AND source_id = ? LIMIT 1`,
    )
    .get(source, sourceId)

  const incomingIsBaseline = opportunity.last_verified_at == null
  const existingIsVerified = existing?.last_verified_at != null

  // Only block baseline/unverified incoming data from downgrading verified existing records
  if (existing?.id && existingIsVerified && incomingIsBaseline) {
    return {
      id: existing.id,
      inserted: false,
      skipped: true,
      reason: 'baseline cannot downgrade verified record'
    }
  }

  // Otherwise allow updates (including verified→verified ingestion refresh)
  if (existing?.id) {
    return { id: existing.id, inserted: false }
  }

  // IMPORTANT:
  // `funding_opportunities.id` is the DB primary key. Never reuse dataset IDs here because
  // different sources can collide (e.g. "nat-snap") which triggers UNIQUE constraint failures.
  // Stability/deduplication is achieved via (source, source_id), not the primary key.
  const id = crypto.randomUUID()
  const isNational = deriveIsNational(opportunity)
  const record = {
    title: opportunity.title?.trim(),
    sponsor: opportunity.sponsor?.trim() ?? null,
    description: opportunity.description ?? null,
    source_url: opportunity.source_url ?? opportunity.url ?? opportunity.application_url ?? null,
    eligibility_bullets: JSON.stringify(
      ensureArray(opportunity.eligibility_bullets),
    ),
    match_reasons: JSON.stringify(ensureArray(opportunity.match_reasons)),
    amount_min:
      typeof opportunity.amount_min === 'number'
        ? opportunity.amount_min
        : null,
    amount_max:
      typeof opportunity.amount_max === 'number'
        ? opportunity.amount_max
        : null,
    amount_description: opportunity.amount_description ?? null,
    deadline: opportunity.deadline ?? null,
    deadline_type: opportunity.deadline_type ?? null,
    application_url: opportunity.application_url ?? null,
    is_national: isNational ? 1 : 0,
    state: opportunity.state ?? (isNational ? 'nationwide' : null),
    categories: JSON.stringify(ensureArray(opportunity.categories)),
    keywords: JSON.stringify(ensureArray(opportunity.keywords)),
    opportunity_type: opportunity.opportunity_type ?? 'grant',
    type: opportunity.type ?? 'OPPORTUNITY',
    last_verified_at: opportunity.last_verified_at ?? null,
    profile_id: opportunity.profile_id ?? null,
    requires_501c3: opportunity.requires_501c3 ? 1 : 0,
    requires_match: opportunity.requires_match ? 1 : 0,
    match_percentage:
      typeof opportunity.match_percentage === 'number'
        ? opportunity.match_percentage
        : null,
    notes: opportunity.notes ?? null,
    record_origin: deriveRecordOrigin(opportunity),
  }

  const insert = db.prepare(`
    INSERT INTO funding_opportunities (
      id,
      title,
      sponsor,
      source,
      source_id,
      source_url,
      record_origin,
      description,
      eligibility_bullets,
      amount_min,
      amount_max,
      amount_description,
      deadline,
      deadline_type,
      application_url,
      is_national,
      state,
      categories,
      keywords,
      opportunity_type,
      type,
      last_verified_at,
      profile_id,
      requires_501c3,
      requires_match,
      match_percentage,
      match_reasons,
      notes,
      is_active,
      last_crawled
    ) VALUES (
      @id,
      @title,
      @sponsor,
      @source,
      @source_id,
      @source_url,
      @record_origin,
      @description,
      @eligibility_bullets,
      @amount_min,
      @amount_max,
      @amount_description,
      @deadline,
      @deadline_type,
      @application_url,
      @is_national,
      @state,
      @categories,
      @keywords,
      @opportunity_type,
      @type,
      @last_verified_at,
      @profile_id,
      @requires_501c3,
      @requires_match,
      @match_percentage,
      @match_reasons,
      @notes,
      1,
      CURRENT_TIMESTAMP
    )
  `)

  insert.run({
    id,
    title: record.title,
    sponsor: record.sponsor,
    source,
    source_id: sourceId,
    source_url: record.source_url,
    record_origin: record.record_origin,
    description: record.description,
    eligibility_bullets: record.eligibility_bullets,
    amount_min: record.amount_min,
    amount_max: record.amount_max,
    amount_description: record.amount_description,
    deadline: record.deadline,
    deadline_type: record.deadline_type,
    application_url: record.application_url,
    is_national: record.is_national,
    state: record.state,
    categories: record.categories,
    keywords: record.keywords,
    opportunity_type: record.opportunity_type,
    type: record.type,
    last_verified_at: record.last_verified_at,
    profile_id: record.profile_id,
    requires_501c3: record.requires_501c3,
    requires_match: record.requires_match,
    match_percentage: record.match_percentage,
    match_reasons: record.match_reasons,
    notes: record.notes,
  })

  return { id, inserted: true }
}

export function bulkUpsertFundingOpportunities(db, opportunities = []) {
  const inserted = []
  opportunities.forEach((opportunity) => {
    const result = upsertFundingOpportunity(db, opportunity)
    if (result.inserted) {
      inserted.push(result.id)
    }
  })
  return inserted
}
