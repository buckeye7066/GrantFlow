import crypto from 'crypto'
import { computeConfidence } from './confidence.js'
import { buildCanonicalKey } from './normalize.js'

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

function diffChangedFields(prev = {}, next = {}) {
  const changed = []
  const keys = new Set([...Object.keys(prev || {}), ...Object.keys(next || {})])
  keys.forEach((k) => {
    const a = prev?.[k]
    const b = next?.[k]
    if (JSON.stringify(a) !== JSON.stringify(b)) changed.push(k)
  })
  return changed
}

export async function upsertProgramWithVersion({
  db,
  track,
  normalized,
  extractedText,
  contentHash,
  sourceUrlHash,
  httpStatus,
  contentType,
  fetchedAt,
}) {
  const table = track === 'PROVIDER' ? 'programs_provider' : 'programs_client'

  const canonicalKey = buildCanonicalKey({
    fundingTrack: track,
    jurisdiction: normalized.jurisdiction,
    state: normalized.state,
    county: normalized.county,
    administeringAgency: normalized.administering_agency,
    programName: normalized.program_name,
    sourceUrl: normalized.source_url,
  })

  const existing = await db
    .prepare(`SELECT * FROM ${table} WHERE canonical_key = ? LIMIT 1`)
    .get(canonicalKey)

  const programId = existing?.program_id || crypto.randomUUID()

  const prevSnapshot = existing
    ? {
        program_name: existing.program_name,
        funding_track: track,
        jurisdiction: existing.jurisdiction,
        state: existing.state,
        county: existing.county,
        administering_agency: existing.administering_agency,
        program_type: existing.program_type,
        eligible_population: existing.eligible_population,
        covered_services: existing.covered_services,
        income_limits: existing.income_limits,
        diagnosis_requirements: existing.diagnosis_requirements,
        age_requirements: existing.age_requirements,
        provider_requirements: existing.provider_requirements,
        funding_amounts: safeJsonParse(existing.funding_amounts, []),
        renewal_cycle: existing.renewal_cycle,
        application_method: existing.application_method,
        source_url: existing.source_url,
      }
    : null

  const nextSnapshot = {
    ...normalized,
    funding_track: track,
    funding_amounts: Array.isArray(normalized.funding_amounts)
      ? normalized.funding_amounts
      : normalized.funding_amounts
      ? [normalized.funding_amounts]
      : [],
  }

  const changedFields = prevSnapshot ? diffChangedFields(prevSnapshot, nextSnapshot) : []
  const deactivateDueToStatus = httpStatus === 404 || httpStatus === 410
  const wasActive = existing ? Number(existing.is_active) === 1 : true
  const isSuccessfulFetch = typeof httpStatus === 'number' ? httpStatus >= 200 && httpStatus < 400 : true
  const shouldReactivate = existing && !wasActive && isSuccessfulFetch && !deactivateDueToStatus

  const changeType = (() => {
    if (!existing) return 'created'
    if (deactivateDueToStatus && wasActive) return 'discontinued'
    if (shouldReactivate) return 'reactivated'
    if (changedFields.length > 0 || existing.last_content_hash !== contentHash) return 'updated'
    return 'unchanged'
  })()

  const confidence = computeConfidence(track, nextSnapshot)

  // Maintain a lightweight change_log[] on the program row (last ~25 items)
  const existingLog = safeJsonParse(existing?.change_log, [])
  const newLog =
    changeType === 'updated' || changeType === 'created'
      ? [
          ...existingLog,
          {
            at: new Date().toISOString(),
            change_type: changeType,
            changed_fields: changedFields,
            source_url: normalized.source_url,
            content_hash: contentHash,
          },
        ].slice(-25)
      : existingLog

  const fundingAmountsJson = JSON.stringify(nextSnapshot.funding_amounts || [])
  const changeLogJson = JSON.stringify(newLog)
  const sourceUrl = normalized.source_url

  const nextIsActive = deactivateDueToStatus ? 0 : 1

  if (!existing) {
    const cols = track === 'PROVIDER'
      ? `
        program_id, program_name, funding_track, jurisdiction, state, county,
        administering_agency, program_type, eligible_population, covered_services,
        income_limits, diagnosis_requirements, age_requirements, provider_requirements,
        funding_amounts, renewal_cycle, application_method, source_url, last_verified,
        change_log, is_active, confidence, canonical_key, source_url_hash,
        last_seen_at, last_fetch_status, last_content_hash
      `
      : `
        program_id, program_name, funding_track, jurisdiction, state, county,
        administering_agency, program_type, eligible_population, covered_services,
        income_limits, diagnosis_requirements, age_requirements,
        funding_amounts, renewal_cycle, application_method, source_url, last_verified,
        change_log, is_active, confidence, canonical_key, source_url_hash,
        last_seen_at, last_fetch_status, last_content_hash
      `

    const placeholders = cols
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(() => '?')
      .join(', ')

    const values = track === 'PROVIDER'
      ? [
          programId,
          nextSnapshot.program_name,
          'PROVIDER',
          nextSnapshot.jurisdiction,
          nextSnapshot.state,
          nextSnapshot.county,
          nextSnapshot.administering_agency,
          nextSnapshot.program_type,
          nextSnapshot.eligible_population,
          nextSnapshot.covered_services,
          nextSnapshot.income_limits,
          nextSnapshot.diagnosis_requirements,
          nextSnapshot.age_requirements,
          nextSnapshot.provider_requirements || null,
          fundingAmountsJson,
          nextSnapshot.renewal_cycle,
          nextSnapshot.application_method,
          sourceUrl,
          nextSnapshot.last_verified,
          changeLogJson,
          nextIsActive,
          confidence,
          canonicalKey,
          sourceUrlHash || sha256(sourceUrl),
          new Date().toISOString(),
          httpStatus ?? null,
          contentHash,
        ]
      : [
          programId,
          nextSnapshot.program_name,
          'CLIENT',
          nextSnapshot.jurisdiction,
          nextSnapshot.state,
          nextSnapshot.county,
          nextSnapshot.administering_agency,
          nextSnapshot.program_type,
          nextSnapshot.eligible_population,
          nextSnapshot.covered_services,
          nextSnapshot.income_limits,
          nextSnapshot.diagnosis_requirements,
          nextSnapshot.age_requirements,
          fundingAmountsJson,
          nextSnapshot.renewal_cycle,
          nextSnapshot.application_method,
          sourceUrl,
          nextSnapshot.last_verified,
          changeLogJson,
          nextIsActive,
          confidence,
          canonicalKey,
          sourceUrlHash || sha256(sourceUrl),
          new Date().toISOString(),
          httpStatus ?? null,
          contentHash,
        ]

    await db.prepare(`INSERT INTO ${table} (${cols}) VALUES (${placeholders})`).run(...values)
  } else if (changeType !== 'unchanged') {
    if (track === 'PROVIDER') {
      await db.prepare(
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
              source_url = ?,
              last_verified = ?,
              change_log = ?,
              is_active = ?,
              confidence = ?,
              last_seen_at = ?,
              last_fetch_status = ?,
              last_content_hash = ?,
              updated_at = CURRENT_TIMESTAMP
          WHERE program_id = ?
        `,
      ).run(
        nextSnapshot.program_name,
        nextSnapshot.jurisdiction,
        nextSnapshot.state,
        nextSnapshot.county,
        nextSnapshot.administering_agency,
        nextSnapshot.program_type,
        nextSnapshot.eligible_population,
        nextSnapshot.covered_services,
        nextSnapshot.income_limits,
        nextSnapshot.diagnosis_requirements,
        nextSnapshot.age_requirements,
        nextSnapshot.provider_requirements || null,
        fundingAmountsJson,
        nextSnapshot.renewal_cycle,
        nextSnapshot.application_method,
        sourceUrl,
        nextSnapshot.last_verified,
        changeLogJson,
        nextIsActive,
        confidence,
        new Date().toISOString(),
        httpStatus ?? null,
        contentHash,
        programId,
      )
    } else {
      await db.prepare(
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
              funding_amounts = ?,
              renewal_cycle = ?,
              application_method = ?,
              source_url = ?,
              last_verified = ?,
              change_log = ?,
              is_active = ?,
              confidence = ?,
              last_seen_at = ?,
              last_fetch_status = ?,
              last_content_hash = ?,
              updated_at = CURRENT_TIMESTAMP
          WHERE program_id = ?
        `,
      ).run(
        nextSnapshot.program_name,
        nextSnapshot.jurisdiction,
        nextSnapshot.state,
        nextSnapshot.county,
        nextSnapshot.administering_agency,
        nextSnapshot.program_type,
        nextSnapshot.eligible_population,
        nextSnapshot.covered_services,
        nextSnapshot.income_limits,
        nextSnapshot.diagnosis_requirements,
        nextSnapshot.age_requirements,
        fundingAmountsJson,
        nextSnapshot.renewal_cycle,
        nextSnapshot.application_method,
        sourceUrl,
        nextSnapshot.last_verified,
        changeLogJson,
        nextIsActive,
        confidence,
        new Date().toISOString(),
        httpStatus ?? null,
        contentHash,
        programId,
      )
    }
  } else {
    // even if unchanged, keep liveness markers fresh
    await db.prepare(
      `
        UPDATE ${table}
        SET last_seen_at = ?,
            last_fetch_status = ?,
            last_content_hash = ?,
            last_verified = COALESCE(last_verified, ?)
        WHERE program_id = ?
      `,
    ).run(new Date().toISOString(), httpStatus ?? null, contentHash, normalized.last_verified, programId)
  }

  // Write version row (only if new hash or created/updated)
  let versionId = null
  if (changeType !== 'unchanged') {
    const normalizedPayload = JSON.stringify(nextSnapshot)
    const changedFieldsJson = JSON.stringify(changedFields)
    const versionInsertSql =
      db?.dialect === 'postgres'
        ? `
            INSERT INTO program_versions (
              funding_track, program_id, source_url, fetched_at, http_status, content_type,
              content_hash, extracted_text, normalized_payload, change_type, changed_fields, change_summary
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT DO NOTHING
          `
        : `
            INSERT OR IGNORE INTO program_versions (
              funding_track, program_id, source_url, fetched_at, http_status, content_type,
              content_hash, extracted_text, normalized_payload, change_type, changed_fields, change_summary
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `

    const versionInsert = db.prepare(versionInsertSql)
    await versionInsert.run(
      track,
      programId,
      sourceUrl,
      fetchedAt ?? new Date().toISOString(),
      httpStatus ?? null,
      contentType ?? null,
      contentHash,
      extractedText || null,
      normalizedPayload,
      changeType,
      changedFieldsJson,
      changedFields.length > 0 ? `Changed: ${changedFields.join(', ')}` : null,
    )

    const verRow = await db
      .prepare(
        `
          SELECT id
          FROM program_versions
          WHERE funding_track = ? AND program_id = ? AND content_hash = ?
          ORDER BY created_at DESC
          LIMIT 1
        `,
      )
      .get(track, programId, contentHash)
    versionId = verRow?.id ?? null

    if (
      changeType === 'created' ||
      changeType === 'updated' ||
      changeType === 'discontinued' ||
      changeType === 'reactivated'
    ) {
      await db.prepare(
        `
          INSERT INTO program_change_events (
            funding_track, program_id, version_id, event_type, changed_fields, summary, confidence
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
      ).run(
        track,
        programId,
        versionId,
        changeType === 'created'
          ? 'created'
          : changeType === 'updated'
          ? 'updated'
          : changeType === 'discontinued'
          ? 'discontinued'
          : 'reactivated',
        JSON.stringify(changedFields),
        changeType === 'discontinued'
          ? 'Source URL returned 404/410; marking program inactive'
          : changeType === 'reactivated'
          ? 'Source URL became available again; marking program active'
          : changedFields.length > 0
          ? `Updated fields: ${changedFields.join(', ')}`
          : changeType === 'created'
          ? 'Created'
          : changeType === 'updated'
          ? `Content hash changed (extracted text or raw content differs); no normalized field changes detected`
          : 'Updated',
        confidence,
      )
    }
  }

  return {
    program_id: programId,
    canonical_key: canonicalKey,
    change_type: changeType,
    changed_fields: changedFields,
    confidence,
    version_id: versionId,
  }
}

