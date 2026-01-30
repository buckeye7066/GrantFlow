import crypto from 'crypto'

function ensureArray(value) {
  if (!value) return []
  if (Array.isArray(value)) return value
  return [value]
}

function normalizeNonEmptyString(value) {
  if (value == null) return null
  const text = String(value).trim()
  return text.length > 0 ? text : null
}

function normalizeUrl(value) {
  const text = normalizeNonEmptyString(value)
  return text
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

function toDbBoolean(db, value) {
  const bool = Boolean(value)
  return db?.dialect === 'postgres' ? bool : bool ? 1 : 0
}

function deriveRecordOrigin(opportunity) {
  const origin = opportunity?.record_origin
  if (typeof origin === 'string' && origin.length > 0) return origin
  return 'live_crawl'
}

function normalizeDateLikeOrNull(value) {
  if (value == null) return null
  if (typeof value === 'string' && value.trim() === '') return null
  return value
}

export async function upsertFundingOpportunity(db, opportunity) {
  const source = opportunity.source ?? 'crawler'
  const title = normalizeNonEmptyString(opportunity?.title)
  if (!title) {
    return {
      id: null,
      inserted: false,
      skipped: true,
      reason: 'missing title',
    }
  }

  const recordOrigin = deriveRecordOrigin(opportunity)
  const sourceUrl = normalizeUrl(opportunity.source_url ?? opportunity.url ?? opportunity.application_url)
  const applicationUrl = normalizeUrl(opportunity.application_url)
  const evidenceUrl = normalizeUrl(opportunity.evidence_url ?? sourceUrl ?? applicationUrl)

  // Live-crawled opportunities must have at least one concrete URL for traceability.
  if (recordOrigin === 'live_crawl' && !sourceUrl && !applicationUrl && !evidenceUrl) {
    return {
      id: null,
      inserted: false,
      skipped: true,
      reason: 'missing evidence/source/application URL',
    }
  }

  const sourceId =
    opportunity.source_id ??
    // Many crawler datasets ship a stable `id` field; treat that as the source_id when present.
    opportunity.id ??
    stableSourceIdFromOpportunity(source, opportunity)

  // Check if record exists and if it's verified
  const existing = await db
    .prepare(
      `SELECT id, last_verified_at FROM funding_opportunities WHERE source = ? AND source_id = ? LIMIT 1`,
    )
    .get(source, sourceId)

  // Treat live crawl records as verified even if caller omits last_verified_at.
  const incomingIsBaseline = recordOrigin !== 'live_crawl' && opportunity.last_verified_at == null
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
    const isNational = deriveIsNational(opportunity)

    const record = {
      title,
      sponsor: normalizeNonEmptyString(opportunity.sponsor),
      description: opportunity.description ?? null,
      source_url: sourceUrl,
      evidence_url: evidenceUrl,
      contact_info: opportunity.contact_info ?? null,
      eligibility_bullets: JSON.stringify(ensureArray(opportunity.eligibility_bullets)),
      match_reasons: JSON.stringify(ensureArray(opportunity.match_reasons)),
      amount_min: typeof opportunity.amount_min === 'number' ? opportunity.amount_min : null,
      amount_max: typeof opportunity.amount_max === 'number' ? opportunity.amount_max : null,
      amount_description: opportunity.amount_description ?? null,
      // Postgres DATE cannot accept empty string; normalize to null.
      deadline: normalizeDateLikeOrNull(opportunity.deadline),
      deadline_type: opportunity.deadline_type ?? null,
      application_url: applicationUrl,
      is_national: toDbBoolean(db, isNational),
      state: opportunity.state ?? (isNational ? 'nationwide' : null),
      categories: JSON.stringify(ensureArray(opportunity.categories)),
      keywords: JSON.stringify(ensureArray(opportunity.keywords)),
      opportunity_type: opportunity.opportunity_type ?? 'grant',
      type: opportunity.type ?? 'OPPORTUNITY',
      last_verified_at:
        opportunity.last_verified_at ?? (recordOrigin === 'live_crawl' ? new Date().toISOString() : null),
      profile_id: opportunity.profile_id ?? null,
      requires_501c3: toDbBoolean(db, opportunity.requires_501c3),
      requires_match: toDbBoolean(db, opportunity.requires_match),
      match_percentage: typeof opportunity.match_percentage === 'number' ? opportunity.match_percentage : null,
      notes: opportunity.notes ?? null,
      record_origin: recordOrigin,
    }

    // Conservative merge: never overwrite existing non-null values with null.
    // Always refresh `updated_at` and `last_crawled`.
    const update = db.prepare(`
      UPDATE funding_opportunities
      SET
        title = COALESCE(?, title),
        sponsor = COALESCE(?, sponsor),
        description = COALESCE(?, description),
        source_url = COALESCE(?, source_url),
        evidence_url = COALESCE(?, evidence_url),
        contact_info = COALESCE(?, contact_info),
        record_origin = COALESCE(?, record_origin),
        eligibility_bullets = COALESCE(?, eligibility_bullets),
        amount_min = COALESCE(?, amount_min),
        amount_max = COALESCE(?, amount_max),
        amount_description = COALESCE(?, amount_description),
        deadline = COALESCE(?, deadline),
        deadline_type = COALESCE(?, deadline_type),
        application_url = COALESCE(?, application_url),
        is_national = COALESCE(?, is_national),
        state = COALESCE(?, state),
        categories = COALESCE(?, categories),
        keywords = COALESCE(?, keywords),
        opportunity_type = COALESCE(?, opportunity_type),
        type = COALESCE(?, type),
        last_verified_at = COALESCE(?, last_verified_at),
        profile_id = COALESCE(?, profile_id),
        requires_501c3 = COALESCE(?, requires_501c3),
        requires_match = COALESCE(?, requires_match),
        match_percentage = COALESCE(?, match_percentage),
        match_reasons = COALESCE(?, match_reasons),
        notes = COALESCE(?, notes),
        updated_at = CURRENT_TIMESTAMP,
        last_crawled = CURRENT_TIMESTAMP
      WHERE id = ?
    `)

    await update.run(
      record.title,
      record.sponsor,
      record.description,
      record.source_url,
      record.evidence_url,
      record.contact_info,
      record.record_origin,
      record.eligibility_bullets,
      record.amount_min,
      record.amount_max,
      record.amount_description,
      record.deadline,
      record.deadline_type,
      record.application_url,
      record.is_national,
      record.state,
      record.categories,
      record.keywords,
      record.opportunity_type,
      record.type,
      record.last_verified_at,
      record.profile_id,
      record.requires_501c3,
      record.requires_match,
      record.match_percentage,
      record.match_reasons,
      record.notes,
      existing.id,
    )

    return { id: existing.id, inserted: false, updated: true, skipped: false }
  }

  // IMPORTANT:
  // `funding_opportunities.id` is the DB primary key. Never reuse dataset IDs here because
  // different sources can collide (e.g. "nat-snap") which triggers UNIQUE constraint failures.
  // Stability/deduplication is achieved via (source, source_id), not the primary key.
  const id = crypto.randomUUID()
  const isNational = deriveIsNational(opportunity)
  const record = {
    title,
    sponsor: normalizeNonEmptyString(opportunity.sponsor),
    description: opportunity.description ?? null,
    source_url: sourceUrl,
    evidence_url: evidenceUrl,
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
    // Postgres rejects empty-string dates (e.g. ""), so normalize to null.
    deadline: normalizeDateLikeOrNull(opportunity.deadline),
    deadline_type: opportunity.deadline_type ?? null,
    application_url: applicationUrl,
    is_national: toDbBoolean(db, isNational),
    state: opportunity.state ?? (isNational ? 'nationwide' : null),
    categories: JSON.stringify(ensureArray(opportunity.categories)),
    keywords: JSON.stringify(ensureArray(opportunity.keywords)),
    opportunity_type: opportunity.opportunity_type ?? 'grant',
    type: opportunity.type ?? 'OPPORTUNITY',
    last_verified_at:
      opportunity.last_verified_at ?? (recordOrigin === 'live_crawl' ? new Date().toISOString() : null),
    profile_id: opportunity.profile_id ?? null,
    requires_501c3: toDbBoolean(db, opportunity.requires_501c3),
    requires_match: toDbBoolean(db, opportunity.requires_match),
    match_percentage:
      typeof opportunity.match_percentage === 'number'
        ? opportunity.match_percentage
        : null,
    notes: opportunity.notes ?? null,
    record_origin: recordOrigin,
  }

  const insert = db.prepare(`
    INSERT INTO funding_opportunities (
      id,
      title,
      sponsor,
      source,
      source_id,
      source_url,
      evidence_url,
      contact_info,
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
      @evidence_url,
      @contact_info,
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
      @is_active,
      CURRENT_TIMESTAMP
    )
  `)

  await insert.run({
    id,
    title: record.title,
    sponsor: record.sponsor,
    source,
    source_id: sourceId,
    source_url: record.source_url,
    evidence_url: record.evidence_url,
    contact_info: record.contact_info,
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
    is_active: toDbBoolean(db, true),
  })

  return { id, inserted: true, skipped: false }
}

export async function bulkUpsertFundingOpportunities(db, opportunities = []) {
  const inserted = []
  for (const opportunity of opportunities) {
    const result = await upsertFundingOpportunity(db, opportunity)
    if (result?.inserted) inserted.push(result.id)
  }
  return inserted
}
