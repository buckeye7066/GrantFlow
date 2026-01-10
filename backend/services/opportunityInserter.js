import crypto from 'crypto'

function ensureArray(value) {
  if (!value) return []
  if (Array.isArray(value)) return value
  return [value]
}

function deriveIsNational(opportunity) {
  return (
    opportunity?.is_national === true ||
    opportunity?.is_national === 1 ||
    opportunity?.state === 'nationwide'
  )
}

function deriveRecordOrigin(opportunity) {
  const origin = typeof opportunity?.record_origin === 'string'
    ? opportunity.record_origin.trim()
    : ''

  // Clamp to allowed values (matches schema CHECK constraint).
  if (origin === 'live_crawl') return 'live_crawl'
  if (origin === 'curated_verified') return 'curated_verified'
  if (origin === 'manual') return 'manual'
  if (origin === 'synthetic') return 'synthetic'
  return 'live_crawl'
}

export function upsertFundingOpportunity(db, opportunity) {
  const source = opportunity.source ?? 'crawler'
  const sourceId =
    opportunity.source_id ??
    `${source}-${crypto.randomUUID()}`

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

  const id = opportunity.id ?? crypto.randomUUID()
  const isNational = deriveIsNational(opportunity)
  const record = {
    title: opportunity.title?.trim(),
    sponsor: opportunity.sponsor?.trim() ?? null,
    description: opportunity.description ?? null,
    source_url: opportunity.source_url ?? opportunity.url ?? opportunity.application_url ?? null,
    contact_info: opportunity.contact_info ?? null,
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
    evidence_url: opportunity.evidence_url ?? null,
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

  // Otherwise allow updates (including verified→verified ingestion refresh)
  if (existing?.id) {
    const update = db.prepare(`
      UPDATE funding_opportunities
      SET
        title = @title,
        sponsor = @sponsor,
        description = @description,
        source_url = COALESCE(@source_url, source_url),
        contact_info = COALESCE(@contact_info, contact_info),
        record_origin = COALESCE(@record_origin, record_origin),
        eligibility_bullets = @eligibility_bullets,
        amount_min = @amount_min,
        amount_max = @amount_max,
        amount_description = @amount_description,
        deadline = @deadline,
        deadline_type = @deadline_type,
        application_url = @application_url,
        is_national = @is_national,
        state = @state,
        categories = @categories,
        keywords = @keywords,
        opportunity_type = @opportunity_type,
        type = @type,
        evidence_url = COALESCE(@evidence_url, evidence_url),
        last_verified_at = COALESCE(@last_verified_at, last_verified_at),
        profile_id = @profile_id,
        requires_501c3 = @requires_501c3,
        requires_match = @requires_match,
        match_percentage = @match_percentage,
        match_reasons = @match_reasons,
        notes = @notes,
        is_active = 1,
        last_crawled = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = @id
    `)

    const result = update.run({
      id: existing.id,
      title: record.title,
      sponsor: record.sponsor,
      description: record.description,
      source_url: record.source_url,
      contact_info: record.contact_info,
      record_origin: record.record_origin,
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
      evidence_url: record.evidence_url,
      last_verified_at: record.last_verified_at,
      profile_id: record.profile_id,
      requires_501c3: record.requires_501c3,
      requires_match: record.requires_match,
      match_percentage: record.match_percentage,
      match_reasons: record.match_reasons,
      notes: record.notes,
    })

    return { id: existing.id, inserted: false, updated: (result?.changes ?? 0) > 0 }
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
      contact_info,
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
      evidence_url,
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
      @contact_info,
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
      @evidence_url,
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
    contact_info: record.contact_info,
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
    evidence_url: record.evidence_url,
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
