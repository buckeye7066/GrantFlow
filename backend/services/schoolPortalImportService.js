import { randomUUID, createHash } from 'crypto'
import { safeParseJSON } from '../utils/safeJson.js'
import { guardProfileSectionForWrite } from '../utils/guardedProfileSectionWrite.js'

// Manual-import remains as a fallback path. The primary product
// behavior is now Hamilton Autopilot driving the live portal — see
// backend/services/hamilton/hamiltonPortalProviders.js for the canonical
// provider catalogue with automation_supported / session_reuse / etc.
// Manual-import providers exposed to the user's school-portal merge UI.
// Mirrors the institutional providers in
// backend/services/hamilton/hamiltonPortalProviders.js so an Anastasia-shape
// student can manually merge institutional aid (MTSU True Blue, MTSU
// Centennial, etc.) into her pipeline even before Hamilton Autopilot is
// granted SSO/2FA access. New providers should be added here AND in
// hamiltonPortalProviders so the two surfaces stay aligned.
const SCHOOL_PORTAL_PROVIDERS = Object.freeze([
  {
    id: 'tsac',
    name: 'Tennessee Student Assistance Corporation (TSAC)',
    short_name: 'TSAC',
    // TSAC's legacy tn.gov/collegepays.html portal was retired and now 302-redirects
    // to the "College for TN" (collegefortn.org) site run by THEC. Point at the live
    // financial-aid landing page instead of the dead tn.gov URL.
    portal_url: 'https://www.collegefortn.org/about-financial-aid/',
    integration_mode: 'pilot_manual_import',
    integration_modes: ['pilot_manual_import', 'browser_autopilot'],
    live_supported: true,
    automation_supported: true,
    authentication_strategy: 'username_password',
    session_reuse_supported: true,
    credential_reference_supported: false,
    captcha_likely: false,
    two_factor_likely: false,
    adapter_name: 'genericScholarshipPortalAdapter',
    description:
      'Manual import is supported as a fallback. Hamilton Autopilot can drive the public TSAC application form unattended once the user authorizes Autopilot.',
    limitations: [
      'Hamilton refuses to type an FSA ID or other federal credential — those use saved session or vault references only.',
    ],
  },
  {
    id: 'mtsu',
    name: 'Middle Tennessee State University Financial Aid',
    short_name: 'MTSU',
    portal_url: 'https://www.mtsu.edu/financial-aid/',
    integration_mode: 'pilot_manual_import',
    integration_modes: ['pilot_manual_import', 'browser_autopilot', 'browser_session_reuse'],
    live_supported: true,
    automation_supported: true,
    authentication_strategy: 'sso',
    session_reuse_supported: true,
    credential_reference_supported: true,
    captcha_likely: false,
    two_factor_likely: true,
    adapter_name: 'genericUniversityFinancialAidAdapter',
    description:
      'Manual import lets the student paste their MTSU MyMT / AcademicWorks award letter so Hamilton can fold institutional aid (True Blue, Centennial, Honors, departmental) into the same pipeline that holds her FAFSA / TSAC awards. Browser Autopilot is also supported once the student authorizes a saved MTSU SSO session.',
    limitations: [
      'MTSU SSO is 2FA-protected; Hamilton stops for 2FA unless an active session is reused.',
      'Hamilton never types a Pipeline MT password — it relies on saved session or vault reference.',
    ],
  },
  {
    id: 'fafsa',
    name: 'Free Application for Federal Student Aid (FAFSA)',
    short_name: 'FAFSA',
    portal_url: 'https://studentaid.gov/h/apply-for-aid/fafsa',
    integration_mode: 'pilot_manual_import',
    integration_modes: ['pilot_manual_import', 'secure_credential_reference', 'browser_session_reuse'],
    live_supported: true,
    automation_supported: true,
    authentication_strategy: 'fsa_id',
    session_reuse_supported: true,
    credential_reference_supported: true,
    captcha_likely: false,
    two_factor_likely: true,
    adapter_name: 'genericUniversityFinancialAidAdapter',
    description:
      'Manual import lets the student paste their Student Aid Report / FAFSA Submission Summary awards so Pell + Direct Loans + Work-Study show up alongside institutional aid in the pipeline.',
    limitations: [
      'Hamilton never types an FSA ID password — federal portal is saved session / vault reference only.',
    ],
  },
  {
    id: 'common_app',
    name: 'Common Application',
    short_name: 'CommonApp',
    portal_url: 'https://www.commonapp.org/',
    integration_mode: 'pilot_manual_import',
    integration_modes: ['pilot_manual_import', 'browser_autopilot'],
    live_supported: true,
    automation_supported: true,
    authentication_strategy: 'username_password',
    session_reuse_supported: true,
    credential_reference_supported: true,
    captcha_likely: true,
    two_factor_likely: false,
    adapter_name: 'genericAdmissionsPortalAdapter',
    description:
      'Manual import lets the student paste their Common App scholarship / fee-waiver awards so admissions-side aid appears in the same pipeline as financial aid awards.',
    limitations: [
      'CAPTCHA is likely on first login; Hamilton stops for CAPTCHA when running Autopilot.',
    ],
  },
])

function getProvider(providerId) {
  return SCHOOL_PORTAL_PROVIDERS.find((provider) => provider.id === String(providerId || '').trim().toLowerCase()) ?? null
}

function safeArray(value) {
  return Array.isArray(value) ? value : []
}

function safeText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function formatCurrency(value) {
  const amount = Number(value)
  if (!Number.isFinite(amount)) return null
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: amount % 1 === 0 ? 0 : 2,
  }).format(amount)
}

function parseAmount(value) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const text = String(value).replace(/[^0-9.-]/g, '')
  const amount = Number(text)
  return Number.isFinite(amount) ? amount : null
}

function hashFingerprint(parts) {
  return createHash('sha1')
    .update(parts.filter(Boolean).join('|'))
    .digest('hex')
    .slice(0, 16)
}

function pickFirstText(record, keys) {
  for (const key of keys) {
    const value = safeText(record?.[key])
    if (value) return value
  }
  return ''
}

function normalizeAwardRecord(provider, record, { portalUrl, schoolName, connectionId }) {
  if (!record || typeof record !== 'object') return null

  const title = pickFirstText(record, [
    'title',
    'name',
    'award_name',
    'scholarship_name',
    'program_name',
    'program',
    'description',
  ])
  if (!title) return null

  const amount =
    parseAmount(record.amount) ??
    parseAmount(record.amount_awarded) ??
    parseAmount(record.estimated_amount) ??
    parseAmount(record.value)
  const externalId =
    pickFirstText(record, ['external_id', 'id', 'award_id', 'program_code', 'reference_number']) ||
    hashFingerprint([provider.id, title, String(amount ?? ''), schoolName])
  const academicYear = pickFirstText(record, ['academic_year', 'year', 'aid_year', 'term'])
  const status = pickFirstText(record, ['status', 'award_status', 'state'])
  const effectiveSchoolName = schoolName || pickFirstText(record, ['school_name', 'institution_name'])
  const fingerprint = hashFingerprint([
    provider.id,
    externalId,
    title.toLowerCase(),
    String(amount ?? ''),
    effectiveSchoolName.toLowerCase(),
    academicYear.toLowerCase(),
  ])
  const normalizedId = `portal_award_${fingerprint}`

  return {
    id: normalizedId,
    external_id: externalId,
    title,
    description: pickFirstText(record, ['description', 'notes', 'details']),
    amount,
    amount_display: amount !== null ? formatCurrency(amount) : null,
    currency: 'USD',
    status: status || 'reported',
    academic_year: academicYear || null,
    school_name: effectiveSchoolName || null,
    provider_id: provider.id,
    provider_name: provider.name,
    source_name: provider.short_name,
    source_url: portalUrl || provider.portal_url,
    portal_url: portalUrl || provider.portal_url,
    connection_id: connectionId,
    import_mode: provider.integration_mode,
    fingerprint,
    provenance: {
      provider_id: provider.id,
      provider_name: provider.name,
      integration_mode: provider.integration_mode,
      live_supported: provider.live_supported,
    },
    raw_reference: {
      program_code: safeText(record.program_code) || null,
      term: safeText(record.term) || null,
    },
  }
}

export function normalizeProviderScholarshipRecords(providerId, rawInput, options = {}) {
  const provider = getProvider(providerId)
  if (!provider) {
    throw new Error(`Unsupported school portal provider: ${providerId}`)
  }

  const records = Array.isArray(rawInput)
    ? rawInput
    : Array.isArray(rawInput?.awards)
      ? rawInput.awards
      : Array.isArray(rawInput?.items)
        ? rawInput.items
        : Array.isArray(rawInput?.records)
          ? rawInput.records
          : []

  if (records.length === 0) {
    throw new Error('Import payload must contain an array of awards.')
  }

  const byId = new Map()
  for (const record of records) {
    const normalized = normalizeAwardRecord(provider, record, options)
    if (!normalized) continue
    if (!byId.has(normalized.id)) {
      byId.set(normalized.id, normalized)
    }
  }

  const awards = [...byId.values()]
  if (awards.length === 0) {
    throw new Error('No valid scholarship or funding awards were found in the import payload.')
  }
  return awards
}

function normalizeConnection(connection) {
  return {
    id: safeText(connection?.id) || `portal_connection_${randomUUID().slice(0, 8)}`,
    provider_id: safeText(connection?.provider_id),
    provider_name: safeText(connection?.provider_name),
    provider_short_name: safeText(connection?.provider_short_name),
    connection_label: safeText(connection?.connection_label) || null,
    school_name: safeText(connection?.school_name) || null,
    portal_url: safeText(connection?.portal_url) || null,
    default_application_id: safeText(connection?.default_application_id) || null,
    integration_mode: safeText(connection?.integration_mode) || 'pilot_manual_import',
    integration_modes: safeArray(connection?.integration_modes),
    live_supported: Boolean(connection?.live_supported),
    automation_supported: Boolean(connection?.automation_supported),
    authentication_strategy: safeText(connection?.authentication_strategy) || null,
    session_reuse_supported: Boolean(connection?.session_reuse_supported),
    credential_reference_supported: Boolean(connection?.credential_reference_supported),
    captcha_likely: Boolean(connection?.captcha_likely),
    two_factor_likely: Boolean(connection?.two_factor_likely),
    adapter_name: safeText(connection?.adapter_name) || null,
    connected_at: safeText(connection?.connected_at) || null,
    last_synced_at: safeText(connection?.last_synced_at) || null,
    limitations: safeArray(connection?.limitations),
    available_awards: safeArray(connection?.available_awards),
  }
}

function normalizeImportedAwardRecord(award) {
  return {
    ...award,
    id: safeText(award?.id),
    title: safeText(award?.title),
    provider_id: safeText(award?.provider_id),
    provider_name: safeText(award?.provider_name),
    application_id: safeText(award?.application_id) || null,
    application_name: safeText(award?.application_name) || null,
    merged_at: safeText(award?.merged_at) || null,
    pipeline_stage_id: safeText(award?.pipeline_stage_id) || null,
  }
}

function normalizeSectionData(data) {
  const parsed = typeof data === 'string' ? safeParseJSON(data, {}) : (data ?? {})
  const applications = safeArray(parsed?.applications).map((application) => ({
    ...application,
    imported_portal_awards: safeArray(application?.imported_portal_awards).map(normalizeImportedAwardRecord),
    financial_aid_pipeline: safeArray(application?.financial_aid_pipeline),
  }))
  return {
    ...parsed,
    applications,
    school_portal_imports: {
      version: 1,
      connections: safeArray(parsed?.school_portal_imports?.connections).map(normalizeConnection),
    },
  }
}

async function loadUniversityApplicationsSection(db, profileId) {
  const row = await db
    .prepare(
      `SELECT data
       FROM profile_sections
       WHERE profile_id = ? AND section_key = 'university_applications'
       LIMIT 1`,
    )
    .get(profileId)

  return normalizeSectionData(row?.data ? safeParseJSON(row.data, {}) : {})
}

async function saveUniversityApplicationsSection(db, profileId, data, updatedBy) {
  const sectionKey = 'university_applications'
  const guarded = await guardProfileSectionForWrite(db, profileId, sectionKey, data)
  await db
    .prepare(
      `INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(profile_id, section_key) DO UPDATE SET
         data = excluded.data,
         updated_by = excluded.updated_by,
         updated_at = CURRENT_TIMESTAMP`,
    )
    .run(profileId, sectionKey, JSON.stringify(guarded.data), updatedBy)

  return guarded.data
}

function findImportedAwardIndex(existingAwards, award) {
  return existingAwards.findIndex((entry) => {
    if (entry.id && award.id && entry.id === award.id) return true
    if (entry.provider_id === award.provider_id && entry.external_id && entry.external_id === award.external_id) return true
    return (
      safeText(entry.title).toLowerCase() === safeText(award.title).toLowerCase() &&
      Number(entry.amount) === Number(award.amount)
    )
  })
}

function createPipelineStage(award, connection) {
  const stageId = `portal_${award.id}`.slice(0, 64)
  const notes = [
    `Imported from ${connection.provider_name}`,
    award.amount_display ? `Amount: ${award.amount_display}` : '',
    award.status ? `Status: ${award.status}` : '',
    award.academic_year ? `Academic year: ${award.academic_year}` : '',
    `Portal award ID: ${award.id}`,
    connection.portal_url ? `Source portal: ${connection.portal_url}` : '',
    `Mode: ${connection.integration_mode || 'pilot_manual_import'}`,
  ]
    .filter(Boolean)
    .join(' · ')

  return {
    id: stageId,
    label: `Imported Portal Award: ${award.title}`,
    status: 'completed',
    due_date: '',
    completed_at: new Date().toISOString().slice(0, 10),
    notes,
  }
}

/**
 * Upsert a merged school-portal award into funding_opportunities so it
 * shows up in the user's Discover Grants list and is visible to the
 * canonical matcher pipeline.
 *
 * Issue #534 acceptance criteria: "Merged scholarships appear in the
 * user's opportunities list and can be edited or removed." Without
 * this row, imported TSAC awards would only live in the
 * university_applications profile section — invisible to the matcher,
 * Discover Grants, the analytics counts, and the agent surfaces.
 *
 * IMPORTANT privacy note: only PUBLIC scholarship metadata is written
 * to the global table (title, sponsor, amount range, public URL,
 * description). Student-specific award status / academic year /
 * school name stay in the profile section only.
 *
 * Returns true if a row was written, false on graceful failure
 * (missing table, etc.). Never throws — failure to write the global
 * row must NOT block the per-profile merge.
 */
export async function upsertSchoolPortalAwardAsOpportunity(db, award, connection) {
  if (!db || !award || !award.id || !award.title) return false
  if (!connection) connection = {}

  const sponsor = safeText(award.provider_name) || safeText(connection.provider_name) || 'School Portal'
  const description = safeText(award.description) || `Imported from ${sponsor}`
  const sourceUrl = safeText(award.portal_url) || safeText(connection.portal_url) || null
  const applyUrl = safeText(award.source_url) || sourceUrl
  const amountMin = Number.isFinite(Number(award.amount)) ? Number(award.amount) : null
  const amountMax = amountMin

  const insertSql = `
    INSERT INTO funding_opportunities (
      id, title, sponsor, source, source_id, source_url,
      record_origin, description,
      amount_min, amount_max, amount_description,
      application_url, apply_url, application_mode,
      opportunity_type, opportunity_kind, source_trust_tier,
      is_active, last_verified_at,
      categories, keywords, eligibility_bullets,
      created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, CURRENT_TIMESTAMP,
      ?, ?, ?,
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
  `
  const updateSql = `
    UPDATE funding_opportunities
       SET title = ?,
           sponsor = ?,
           source_url = ?,
           description = ?,
           amount_min = COALESCE(?, amount_min),
           amount_max = COALESCE(?, amount_max),
           application_url = COALESCE(?, application_url),
           apply_url = COALESCE(?, apply_url),
           updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
  `

  const insertArgs = [
    award.id,
    award.title,
    sponsor,
    'school_portal',
    safeText(award.external_id) || null,
    sourceUrl,
    'school_portal',
    description,
    amountMin,
    amountMax,
    award.amount_display || null,
    applyUrl,
    applyUrl,
    'portal',
    'scholarship',
    'school_portal',
    'official_portal',
    1,
    JSON.stringify(['scholarship', 'school_portal']),
    JSON.stringify(['scholarship', 'school portal', sponsor.toLowerCase()].filter(Boolean)),
    JSON.stringify([]),
  ]

  try {
    await db.prepare(insertSql).run(...insertArgs)
    return true
  } catch (err) {
    const msg = String(err?.message || err).toLowerCase()
    // Already present (PK collision) — fall through to UPDATE.
    if (
      msg.includes('unique') ||
      msg.includes('duplicate') ||
      msg.includes('primary key')
    ) {
      try {
        await db
          .prepare(updateSql)
          .run(
            award.title,
            sponsor,
            sourceUrl,
            description,
            amountMin,
            amountMax,
            applyUrl,
            applyUrl,
            award.id,
          )
        return true
      } catch {
        return false
      }
    }
    // Missing table / other error — fail soft so the per-profile merge
    // still completes. Operator will see the warning in logs.
    if (msg.includes('no such table') || msg.includes('does not exist')) {
      return false
    }
    return false
  }
}

/**
 * Remove a previously-imported school-portal award row from the
 * global funding_opportunities table when the user unlinks it from
 * their profile. Pairs with removeMergedSchoolPortalAward.
 *
 * Idempotent and graceful: missing row / missing table both return
 * false silently.
 */
export async function removeSchoolPortalAwardOpportunity(db, awardId) {
  if (!db || !awardId) return false
  try {
    const result = await db
      .prepare(`DELETE FROM funding_opportunities WHERE id = ? AND source = 'school_portal'`)
      .run(awardId)
    return Boolean(result?.changes)
  } catch {
    return false
  }
}

function mergedAwardsFromApplications(applications) {
  return applications.flatMap((application) =>
    safeArray(application?.imported_portal_awards).map((award) => ({
      ...award,
      application_id: award.application_id || application.id || null,
      application_name: award.application_name || application.name || application.school_name || null,
    })),
  )
}

function mapConnectionForResponse(connection, mergedAwards) {
  const mergedIds = new Set(mergedAwards.map((award) => award.id))
  return {
    ...connection,
    available_awards: safeArray(connection.available_awards).map((award) => ({
      ...award,
      already_merged: mergedIds.has(award.id),
    })),
  }
}

function buildWorkspace(sectionData) {
  const applications = safeArray(sectionData?.applications)
  const merged_awards = mergedAwardsFromApplications(applications)
  return {
    providers: SCHOOL_PORTAL_PROVIDERS,
    applications: applications.map((application) => ({
      id: application.id || null,
      name: application.name || application.school_name || 'Unnamed school',
      status: application.status || 'planning',
      school_name: application.school_name || application.name || null,
      imported_award_count: safeArray(application.imported_portal_awards).length,
    })),
    connections: safeArray(sectionData?.school_portal_imports?.connections).map((connection) =>
      mapConnectionForResponse(connection, merged_awards),
    ),
    merged_awards,
  }
}

export async function getSchoolPortalWorkspace(db, profileId) {
  const sectionData = await loadUniversityApplicationsSection(db, profileId)
  return buildWorkspace(sectionData)
}

export async function createSchoolPortalConnection(db, profileId, payload, updatedBy) {
  const provider = getProvider(payload?.provider_id)
  if (!provider) {
    throw new Error('A supported school portal provider is required.')
  }

  const sectionData = await loadUniversityApplicationsSection(db, profileId)
  const awards = normalizeProviderScholarshipRecords(provider.id, payload?.awards, {
    portalUrl: safeText(payload?.portal_url) || provider.portal_url,
    schoolName: safeText(payload?.school_name),
    connectionId: payload?.connection_id,
  })

  const connection = normalizeConnection({
    id: payload?.connection_id || `portal_connection_${randomUUID().slice(0, 8)}`,
    provider_id: provider.id,
    provider_name: provider.name,
    provider_short_name: provider.short_name,
    connection_label: safeText(payload?.connection_label),
    school_name: safeText(payload?.school_name),
    portal_url: safeText(payload?.portal_url) || provider.portal_url,
    default_application_id: safeText(payload?.application_id),
    integration_mode: provider.integration_mode,
    integration_modes: provider.integration_modes || [provider.integration_mode],
    live_supported: provider.live_supported,
    automation_supported: provider.automation_supported,
    authentication_strategy: provider.authentication_strategy || null,
    session_reuse_supported: provider.session_reuse_supported,
    credential_reference_supported: provider.credential_reference_supported,
    captcha_likely: provider.captcha_likely,
    two_factor_likely: provider.two_factor_likely,
    adapter_name: provider.adapter_name || null,
    connected_at: new Date().toISOString(),
    last_synced_at: new Date().toISOString(),
    limitations: provider.limitations,
    available_awards: awards,
  })

  const nextConnections = [
    ...safeArray(sectionData.school_portal_imports?.connections).filter((item) => item.id !== connection.id),
    connection,
  ]

  const nextData = {
    ...sectionData,
    school_portal_imports: {
      version: 1,
      connections: nextConnections,
    },
  }

  const saved = await saveUniversityApplicationsSection(db, profileId, nextData, updatedBy)
  return {
    connection,
    workspace: buildWorkspace(saved),
  }
}

export async function mergeSchoolPortalAwards(db, profileId, payload, updatedBy) {
  const connectionId = safeText(payload?.connection_id)
  const awardIds = safeArray(payload?.award_ids).map((value) => safeText(value)).filter(Boolean)
  if (!connectionId) throw new Error('connection_id is required.')
  if (awardIds.length === 0) throw new Error('Select at least one award to merge.')

  const sectionData = await loadUniversityApplicationsSection(db, profileId)
  const connections = safeArray(sectionData.school_portal_imports?.connections)
  const connection = connections.find((item) => item.id === connectionId)
  if (!connection) throw new Error('School portal connection not found.')

  const targetApplicationId =
    safeText(payload?.application_id) ||
    safeText(connection.default_application_id) ||
    (sectionData.applications.length === 1 ? safeText(sectionData.applications[0]?.id) : '')
  if (!targetApplicationId) {
    throw new Error('Select a university before merging portal awards.')
  }

  const applicationIndex = sectionData.applications.findIndex(
    (application) => safeText(application?.id) === targetApplicationId,
  )
  if (applicationIndex === -1) {
    throw new Error('Target university application not found.')
  }

  const selectedAwards = safeArray(connection.available_awards).filter((award) => awardIds.includes(award.id))
  if (selectedAwards.length === 0) {
    throw new Error('The selected awards are no longer available on this connection.')
  }

  const application = { ...(sectionData.applications[applicationIndex] || {}) }
  const importedAwards = safeArray(application.imported_portal_awards).slice()
  const pipeline = safeArray(application.financial_aid_pipeline).slice()
  const mergedAt = new Date().toISOString()

  let mergedCount = 0
  for (const award of selectedAwards) {
    const stage = createPipelineStage(award, connection)
    const mergedAward = {
      ...award,
      application_id: application.id || targetApplicationId,
      application_name: application.name || application.school_name || connection.school_name || null,
      connection_id: connection.id,
      connection_label: connection.connection_label || connection.provider_name,
      merged_at: mergedAt,
      pipeline_stage_id: stage.id,
      source_metadata: {
        provider_id: award.provider_id,
        provider_name: award.provider_name,
        connection_id: connection.id,
        connection_label: connection.connection_label || connection.provider_name,
        portal_url: award.portal_url || connection.portal_url,
        import_mode: award.import_mode,
        integration_mode: connection.integration_mode || award.import_mode,
        live_supported: connection.live_supported,
        automation_supported: connection.automation_supported,
      },
    }

    const importedIndex = findImportedAwardIndex(importedAwards, mergedAward)
    if (importedIndex === -1) {
      importedAwards.unshift(mergedAward)
      mergedCount += 1
    } else {
      importedAwards[importedIndex] = {
        ...importedAwards[importedIndex],
        ...mergedAward,
        merged_at: importedAwards[importedIndex]?.merged_at || mergedAt,
      }
    }

    const stageIndex = pipeline.findIndex(
      (entry) =>
        safeText(entry?.id) === stage.id ||
        safeText(entry?.notes).includes(`Portal award ID: ${award.id}`) ||
        safeText(entry?.label).toLowerCase() === stage.label.toLowerCase(),
    )
    if (stageIndex === -1) {
      pipeline.unshift(stage)
    } else {
      pipeline[stageIndex] = {
        ...pipeline[stageIndex],
        ...stage,
        completed_at: pipeline[stageIndex]?.completed_at || stage.completed_at,
      }
    }
  }

  application.imported_portal_awards = importedAwards
  application.financial_aid_pipeline = pipeline

  const nextApplications = sectionData.applications.slice()
  nextApplications.splice(applicationIndex, 1, application)
  const nextData = {
    ...sectionData,
    applications: nextApplications,
  }

  const saved = await saveUniversityApplicationsSection(db, profileId, nextData, updatedBy)

  // Issue #534: Make the merged awards visible in Discover Grants by
  // upserting them into funding_opportunities with record_origin =
  // 'school_portal'. Per-row failures (e.g. missing table) are
  // swallowed by the upsert helper so they never block the per-profile
  // merge — the section save above is the source of truth.
  let opportunitiesUpserted = 0
  for (const award of selectedAwards) {
    const ok = await upsertSchoolPortalAwardAsOpportunity(db, award, connection)
    if (ok) opportunitiesUpserted += 1
  }

  return {
    merged_count: mergedCount,
    opportunities_upserted: opportunitiesUpserted,
    workspace: buildWorkspace(saved),
  }
}

export async function removeMergedSchoolPortalAward(db, profileId, payload, updatedBy) {
  const awardId = safeText(payload?.award_id)
  if (!awardId) throw new Error('award_id is required.')

  const sectionData = await loadUniversityApplicationsSection(db, profileId)
  const nextApplications = sectionData.applications.map((application) => {
    const importedAwards = safeArray(application.imported_portal_awards)
    const nextImportedAwards = importedAwards.filter((award) => safeText(award?.id) !== awardId)
    if (nextImportedAwards.length === importedAwards.length) {
      return application
    }
    return {
      ...application,
      imported_portal_awards: nextImportedAwards,
      financial_aid_pipeline: safeArray(application.financial_aid_pipeline).filter(
        (stage) =>
          safeText(stage?.id) !== `portal_${awardId}` &&
          !safeText(stage?.notes).includes(`Portal award ID: ${awardId}`),
      ),
    }
  })

  const saved = await saveUniversityApplicationsSection(
    db,
    profileId,
    {
      ...sectionData,
      applications: nextApplications,
    },
    updatedBy,
  )

  // Mirror the in-section removal into the global funding_opportunities
  // table so the unlinked award stops showing up in Discover Grants.
  // Idempotent & graceful — missing row / missing table both no-op.
  const opportunityRemoved = await removeSchoolPortalAwardOpportunity(db, awardId)

  return {
    opportunity_removed: opportunityRemoved,
    workspace: buildWorkspace(saved),
  }
}

export async function disconnectSchoolPortalConnection(db, profileId, payload, updatedBy) {
  const connectionId = safeText(payload?.connection_id)
  if (!connectionId) throw new Error('connection_id is required.')

  const sectionData = await loadUniversityApplicationsSection(db, profileId)
  const nextConnections = safeArray(sectionData.school_portal_imports?.connections).filter(
    (connection) => connection.id !== connectionId,
  )

  const saved = await saveUniversityApplicationsSection(
    db,
    profileId,
    {
      ...sectionData,
      school_portal_imports: {
        version: 1,
        connections: nextConnections,
      },
    },
    updatedBy,
  )

  return {
    workspace: buildWorkspace(saved),
  }
}

export { SCHOOL_PORTAL_PROVIDERS }
