import crypto from 'crypto'

function ensureArray(value) {
  if (!value) return []
  if (Array.isArray(value)) return value
  return [value]
}

function normalizeHttpUrl(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return null
  try {
    const u = new URL(raw)
    const protocol = String(u.protocol || '').toLowerCase()
    if (protocol !== 'http:' && protocol !== 'https:') return null

    const host = String(u.hostname || '').toLowerCase()
    if (!host) return null
    const blockedHosts = new Set([
      'example.com',
      'example.org',
      'example.net',
      'localhost',
      '127.0.0.1',
    ])
    if (blockedHosts.has(host)) return null
    if (host.endsWith('.local')) return null

    // Normalize to full href (keeps path/query)
    return u.href
  } catch {
    return null
  }
}

function stableSourceIdFromOpportunity(source, opportunity) {
  const urlRaw = opportunity?.source_url ?? opportunity?.url ?? opportunity?.application_url ?? null
  const url = normalizeHttpUrl(urlRaw) || String(urlRaw || '').trim()
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

export async function upsertFundingOpportunity(db, opportunity) {
  const source = opportunity.source ?? 'crawler'
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

  const existingIsVerified = existing?.last_verified_at != null

  const recordOrigin = deriveRecordOrigin(opportunity)
  const sourceUrl = normalizeHttpUrl(opportunity.source_url ?? opportunity.url ?? null)
  const applicationUrl = normalizeHttpUrl(opportunity.application_url ?? null)
  const evidenceUrl =
    normalizeHttpUrl(opportunity.evidence_url ?? null) ||
    sourceUrl ||
    applicationUrl ||
    null

  // REAL-invariant: live crawls must have a real, verifiable URL.
  // If a crawler can't provide one, skip rather than polluting the DB with synthetic entries.
  if (recordOrigin === 'live_crawl' && !evidenceUrl) {
    return {
      id: existing?.id ?? null,
      inserted: false,
      skipped: true,
      reason: 'live_crawl requires a valid evidence/source/application URL',
    }
  }

  // IMPORTANT:
  // `funding_opportunities.id` is the DB primary key. Never reuse dataset IDs here because
  // different sources can collide (e.g. "nat-snap") which triggers UNIQUE constraint failures.
  // Stability/deduplication is achieved via (source, source_id), not the primary key.
  const id = existing?.id ?? crypto.randomUUID()
  const isNational = deriveIsNational(opportunity)

  const effectiveLastVerifiedAt =
    opportunity.last_verified_at ??
    // If this is a live crawl with a verifiable URL, treat it as verified now.
    (recordOrigin === 'live_crawl' && evidenceUrl ? new Date().toISOString() : null)

  const incomingIsBaseline = effectiveLastVerifiedAt == null

  // Only block baseline/unverified incoming data from downgrading verified existing records.
  // NOTE: live_crawl opportunities are verified implicitly when they provide a verifiable URL.
  if (existing?.id && existingIsVerified && incomingIsBaseline) {
    return {
      id: existing.id,
      inserted: false,
      skipped: true,
      reason: 'baseline cannot downgrade verified record',
    }
  }

  const record = {
    title: opportunity.title?.trim(),
    sponsor: opportunity.sponsor?.trim() ?? null,
    description: opportunity.description ?? null,
    source_url: sourceUrl ?? applicationUrl ?? null,
    evidence_url: evidenceUrl,
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
    application_url: applicationUrl ?? null,
    is_national: isNational ? 1 : 0,
    state: opportunity.state ?? (isNational ? 'nationwide' : null),
    categories: JSON.stringify(ensureArray(opportunity.categories)),
    keywords: JSON.stringify(ensureArray(opportunity.keywords)),
    opportunity_type: opportunity.opportunity_type ?? 'grant',
    type: opportunity.type ?? 'OPPORTUNITY',
    last_verified_at: effectiveLastVerifiedAt,
    profile_id: opportunity.profile_id ?? null,
    requires_501c3: opportunity.requires_501c3 ? 1 : 0,
    requires_match: opportunity.requires_match ? 1 : 0,
    match_percentage:
      typeof opportunity.match_percentage === 'number'
        ? opportunity.match_percentage
        : null,
    notes: opportunity.notes ?? null,
    record_origin: recordOrigin,
  }

  if (existing?.id) {
    const update = db.prepare(`
      UPDATE funding_opportunities
      SET
        title = COALESCE(@title, title),
        sponsor = COALESCE(@sponsor, sponsor),
        source_url = COALESCE(@source_url, source_url),
        evidence_url = COALESCE(@evidence_url, evidence_url),
        record_origin = COALESCE(@record_origin, record_origin),
        description = COALESCE(@description, description),
        eligibility_bullets = COALESCE(@eligibility_bullets, eligibility_bullets),
        amount_min = COALESCE(@amount_min, amount_min),
        amount_max = COALESCE(@amount_max, amount_max),
        amount_description = COALESCE(@amount_description, amount_description),
        deadline = COALESCE(@deadline, deadline),
        deadline_type = COALESCE(@deadline_type, deadline_type),
        application_url = COALESCE(@application_url, application_url),
        is_national = COALESCE(@is_national, is_national),
        state = COALESCE(@state, state),
        categories = COALESCE(@categories, categories),
        keywords = COALESCE(@keywords, keywords),
        opportunity_type = COALESCE(@opportunity_type, opportunity_type),
        type = COALESCE(@type, type),
        last_verified_at = COALESCE(@last_verified_at, last_verified_at),
        profile_id = COALESCE(@profile_id, profile_id),
        requires_501c3 = COALESCE(@requires_501c3, requires_501c3),
        requires_match = COALESCE(@requires_match, requires_match),
        match_percentage = COALESCE(@match_percentage, match_percentage),
        match_reasons = COALESCE(@match_reasons, match_reasons),
        notes = COALESCE(@notes, notes),
        is_active = 1,
        last_crawled = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = @id
    `)

    await update.run({
      id,
      title: record.title,
      sponsor: record.sponsor,
      source_url: record.source_url,
      evidence_url: record.evidence_url,
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

    return { id, inserted: false, updated: true }
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

  await insert.run({
    id,
    title: record.title,
    sponsor: record.sponsor,
    source,
    source_id: sourceId,
    source_url: record.source_url,
    evidence_url: record.evidence_url,
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

  return { id, inserted: true, updated: false }
}

export async function bulkUpsertFundingOpportunities(db, opportunities = []) {
  const inserted = []
  for (const opportunity of opportunities) {
    const result = await upsertFundingOpportunity(db, opportunity)
    if (result?.inserted) inserted.push(result.id)
  }
  return inserted
}
