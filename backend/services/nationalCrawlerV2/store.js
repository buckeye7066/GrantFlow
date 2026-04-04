import crypto from 'crypto'

function sha256(text) {
  return crypto.createHash('sha256').update(text || '').digest('hex')
}

function safeJsonParse(value, fallback) {
  if (!value) return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function jsonStable(obj) {
  return JSON.stringify(obj)
}

function diffFields(prev, next) {
  const keys = new Set([...Object.keys(prev || {}), ...Object.keys(next || {})])
  const changed = []
  for (const k of keys) {
    if (jsonStable(prev?.[k]) !== jsonStable(next?.[k])) changed.push(k)
  }
  return changed
}

const ALLOWED_NF_TABLES = ['nf_programs_a', 'nf_programs_b']

function tableFor(track) {
  return track === 'TRACK_B' ? 'nf_programs_b' : 'nf_programs_a'
}

export function upsertNormalizedProgram({
  db,
  crawlRunId,
  normalized,
  contentHash,
  httpStatus,
  contentType,
  parserName,
}) {
  const table = tableFor(normalized.funding_track)
  if (!ALLOWED_NF_TABLES.includes(table)) throw new Error(`upsertNormalizedProgram: invalid table '${table}'`)
  const programId = normalized.program_id
  const fetchedAt = normalized.source_last_crawled_at || new Date().toISOString()

  const existing = db.prepare(`SELECT * FROM ${table} WHERE program_id = ?`).get(programId)

  const deactivateDueToStatus = httpStatus === 404 || httpStatus === 410
  const wasActive = existing ? Number(existing.is_active) === 1 : true
  const isSuccessfulFetch = typeof httpStatus === 'number' ? httpStatus >= 200 && httpStatus < 400 : true
  const shouldReactivate = existing && !wasActive && isSuccessfulFetch && !deactivateDueToStatus

  const toStore = {
    ...normalized,
    eligible_population: JSON.stringify(normalized.eligible_population || []),
    covered_services: JSON.stringify(normalized.covered_services || []),
    income_limits: normalized.income_limits ? JSON.stringify(normalized.income_limits) : null,
    diagnosis_requirements: normalized.diagnosis_requirements ? JSON.stringify(normalized.diagnosis_requirements) : null,
    age_requirements: normalized.age_requirements ? JSON.stringify(normalized.age_requirements) : null,
    provider_requirements: normalized.provider_requirements ? JSON.stringify(normalized.provider_requirements) : null,
    funding_amounts: normalized.funding_amounts ? JSON.stringify(normalized.funding_amounts) : null,
    change_log: JSON.stringify(normalized.change_log || []),
    raw_source_refs: JSON.stringify(normalized.raw_source_refs || []),
  }

  // normalize Track A invariant
  if (normalized.funding_track === 'TRACK_A') {
    toStore.provider_requirements = null
  }

  // Determine change type by payload hash (content-based)
  const payloadHash = sha256(
    JSON.stringify({
      program_name: normalized.program_name,
      jurisdiction: normalized.jurisdiction,
      state: normalized.state,
      county: normalized.county,
      administering_agency: normalized.administering_agency,
      program_type: normalized.program_type,
      eligible_population: normalized.eligible_population,
      covered_services: normalized.covered_services,
      income_limits: normalized.income_limits,
      diagnosis_requirements: normalized.diagnosis_requirements,
      age_requirements: normalized.age_requirements,
      provider_requirements: normalized.provider_requirements,
      funding_amounts: normalized.funding_amounts,
      renewal_cycle: normalized.renewal_cycle,
      application_method: normalized.application_method,
      application_url: normalized.application_url,
      source_url: normalized.source_url,
    }),
  )

  const prevPayloadHash = existing?.last_content_hash || null
  const changed = existing ? prevPayloadHash !== payloadHash : true

  const changeType = (() => {
    if (!existing) return 'created'
    if (deactivateDueToStatus && wasActive) return 'discontinued'
    if (shouldReactivate) return 'reactivated'
    if (changed) return 'updated'
    return 'unchanged'
  })()

  const nextIsActive = deactivateDueToStatus ? 0 : 1

  const nowIso = new Date().toISOString()

  if (!existing) {
    db.prepare(
      `
        INSERT INTO ${table} (
          program_id, program_name, funding_track, jurisdiction, state, county,
          administering_agency, program_type, eligible_population, covered_services,
          income_limits, diagnosis_requirements, age_requirements, provider_requirements,
          funding_amounts, renewal_cycle, application_method, application_url,
          source_url, source_last_crawled_at, last_verified, confidence_score,
          change_log, raw_source_refs, is_active, last_fetch_status, last_content_hash
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
      `,
    ).run(
      programId,
      normalized.program_name,
      normalized.funding_track,
      normalized.jurisdiction,
      normalized.state,
      normalized.county,
      normalized.administering_agency,
      normalized.program_type,
      toStore.eligible_population,
      toStore.covered_services,
      toStore.income_limits,
      toStore.diagnosis_requirements,
      toStore.age_requirements,
      toStore.provider_requirements,
      toStore.funding_amounts,
      normalized.renewal_cycle,
      normalized.application_method,
      normalized.application_url,
      normalized.source_url,
      fetchedAt,
      normalized.last_verified,
      normalized.confidence_score,
      toStore.change_log,
      toStore.raw_source_refs,
      nextIsActive,
      httpStatus ?? null,
      payloadHash,
    )
  } else if (changeType !== 'unchanged') {
    db.prepare(
      `
        UPDATE ${table}
        SET program_name = ?,
            jurisdiction = ?,
            state = ?,
            county = ?,
            administering_agency = ?,
            program_type = ?,
            eligible_population = ?,
            covered_services = ?,
            income_limits = ?,
            diagnosis_requirements = ?,
            age_requirements = ?,
            provider_requirements = ?,
            funding_amounts = ?,
            renewal_cycle = ?,
            application_method = ?,
            application_url = ?,
            source_url = ?,
            source_last_crawled_at = ?,
            last_verified = ?,
            confidence_score = ?,
            raw_source_refs = ?,
            is_active = ?,
            last_fetch_status = ?,
            last_content_hash = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE program_id = ?
      `,
    ).run(
      normalized.program_name,
      normalized.jurisdiction,
      normalized.state,
      normalized.county,
      normalized.administering_agency,
      normalized.program_type,
      toStore.eligible_population,
      toStore.covered_services,
      toStore.income_limits,
      toStore.diagnosis_requirements,
      toStore.age_requirements,
      toStore.provider_requirements,
      toStore.funding_amounts,
      normalized.renewal_cycle,
      normalized.application_method,
      normalized.application_url,
      normalized.source_url,
      fetchedAt,
      normalized.last_verified,
      normalized.confidence_score,
      toStore.raw_source_refs,
      nextIsActive,
      httpStatus ?? null,
      payloadHash,
      programId,
    )
  } else {
    db.prepare(
      `
        UPDATE ${table}
        SET source_last_crawled_at = ?,
            last_verified = COALESCE(last_verified, ?),
            last_fetch_status = ?,
            is_active = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE program_id = ?
      `,
    ).run(fetchedAt, normalized.last_verified, httpStatus ?? null, nextIsActive, programId)
  }

  // Versioning + change log pointers
  const versionId = crypto.randomUUID()
  const prevSnapshot = existing
    ? {
        program_name: existing.program_name,
        jurisdiction: existing.jurisdiction,
        state: existing.state,
        county: existing.county,
        administering_agency: existing.administering_agency,
        program_type: existing.program_type,
        eligible_population: safeJsonParse(existing.eligible_population, []),
        covered_services: safeJsonParse(existing.covered_services, []),
        income_limits: safeJsonParse(existing.income_limits, null),
        diagnosis_requirements: safeJsonParse(existing.diagnosis_requirements, null),
        age_requirements: safeJsonParse(existing.age_requirements, null),
        provider_requirements: safeJsonParse(existing.provider_requirements, null),
        funding_amounts: safeJsonParse(existing.funding_amounts, null),
        renewal_cycle: existing.renewal_cycle,
        application_method: existing.application_method,
        application_url: existing.application_url,
        source_url: existing.source_url,
      }
    : null

  const nextSnapshot = {
    program_name: normalized.program_name,
    jurisdiction: normalized.jurisdiction,
    state: normalized.state,
    county: normalized.county,
    administering_agency: normalized.administering_agency,
    program_type: normalized.program_type,
    eligible_population: normalized.eligible_population || [],
    covered_services: normalized.covered_services || [],
    income_limits: normalized.income_limits || null,
    diagnosis_requirements: normalized.diagnosis_requirements || null,
    age_requirements: normalized.age_requirements || null,
    provider_requirements: normalized.funding_track === 'TRACK_A' ? null : normalized.provider_requirements || null,
    funding_amounts: normalized.funding_amounts || null,
    renewal_cycle: normalized.renewal_cycle || null,
    application_method: normalized.application_method || null,
    application_url: normalized.application_url || null,
    source_url: normalized.source_url,
  }

  const changedFields = prevSnapshot ? diffFields(prevSnapshot, nextSnapshot) : Object.keys(nextSnapshot)
  const diffSummary =
    changeType === 'updated'
      ? `Changed fields: ${changedFields.join(', ')}`
      : changeType === 'created'
      ? 'Created'
      : changeType === 'discontinued'
      ? 'Discontinued (404/410)'
      : changeType === 'reactivated'
      ? 'Reactivated'
      : 'Unchanged'

  db.prepare(
    `
      INSERT INTO nf_program_versions (
        version_id, crawl_run_id, program_id, funding_track, source_url,
        content_hash, fetched_at, http_status, content_type, parser_name,
        normalized_payload, changed_fields, change_type, diff_summary
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    versionId,
    crawlRunId ?? null,
    programId,
    normalized.funding_track,
    normalized.source_url,
    contentHash,
    fetchedAt,
    httpStatus ?? null,
    contentType ?? null,
    parserName ?? null,
    JSON.stringify(nextSnapshot),
    JSON.stringify(changedFields),
    changeType,
    diffSummary,
  )

  const logEntry = {
    version_id: versionId,
    change_type: changeType,
    changed_fields: changedFields,
    at: nowIso,
    content_hash: contentHash,
  }

  const existingLog = safeJsonParse(existing?.change_log, [])
  const updatedLog = [...existingLog, logEntry].slice(-50)

  db.prepare(`UPDATE ${table} SET change_log = ? WHERE program_id = ?`).run(
    JSON.stringify(updatedLog),
    programId,
  )

  return {
    program_id: programId,
    funding_track: normalized.funding_track,
    change_type: changeType,
    version_id: versionId,
    changed_fields: changedFields,
    versions_created: changeType === 'unchanged' ? 0 : 1,
  }
}

