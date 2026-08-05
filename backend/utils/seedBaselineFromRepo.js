import fs from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import crypto from 'crypto'
import { ALLOWED_RECORD_ORIGINS } from './recordOrigins.js'
import { getDefaultSectionData, supportedSectionKeys } from '../config/profileSchema.js'

function resolveBaselineSeedPath() {
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = dirname(__filename)
  // backend/utils -> backend -> repo root -> seed/baseline-profiles.json
  return join(__dirname, '..', '..', 'seed', 'baseline-profiles.json')
}

function safeJsonString(value, fallback = '[]') {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value ?? JSON.parse(fallback))
  } catch {
    return fallback
  }
}

function coerceBoolInt(value, defaultValue = 0) {
  if (value === true || value === 1) return 1
  if (value === false || value === 0) return 0
  return defaultValue
}

function normalizeApplicantType(raw) {
  const v = String(raw ?? '').trim()
  // Map historic/legacy values into production schema.
  if (!v) return 'individual_need'
  if (v === 'individual') return 'individual_need'
  const allowed = new Set([
    'individual_need',
    'family',
    'organization',
    'nonprofit',
    'small_business',
    'student',
    'college_student',
    'high_school_student',
    'medical_assistance',
    'government',
    'other',
  ])
  return allowed.has(v) ? v : 'other'
}

function normalizeGrantStatus(raw) {
  const v = String(raw ?? '').trim()
  const allowed = new Set([
    'discovered',
    'interested',
    'drafting',
    'app_prep',
    'revision',
    'submitted',
    'under_review',
    'awarded',
    'rejected',
    'closed',
    'archived',
  ])
  return allowed.has(v) ? v : 'discovered'
}

function normalizeRecordOrigin(raw) {
  const v = String(raw ?? '').trim()
  return ALLOWED_RECORD_ORIGINS.has(v) ? v : 'curated_verified'
}

function normalizeDocumentStatus(raw) {
  if ((raw === null || raw === undefined)) return null
  const v = String(raw ?? '').trim()
  if (!v) return null
  // Canonical statuses (SQLite + Postgres schemas)
  const allowed = new Set(['draft', 'review', 'final', 'submitted'])
  if (allowed.has(v)) return v
  // Legacy values observed during early deployments/seeding.
  if (v === 'processed') return 'draft'
  if (v === 'pending') return 'draft'
  return 'draft'
}

function expandDefaultProfileSections(profiles, sections) {
  const existing = new Map()
  const expanded = []

  for (const section of Array.isArray(sections) ? sections : []) {
    const profileId = String(section?.profile_id || '').trim()
    const sectionKey = String(section?.section_key || '').trim()
    if (!profileId || !sectionKey) continue
    existing.set(`${profileId}::${sectionKey}`, true)
    expanded.push(section)
  }

  for (const profile of Array.isArray(profiles) ? profiles : []) {
    const profileId = String(profile?.id || '').trim()
    if (!profileId) continue
    for (const sectionKey of supportedSectionKeys) {
      const key = `${profileId}::${sectionKey}`
      if (existing.has(key)) continue
      expanded.push({
        profile_id: profileId,
        section_key: sectionKey,
        data: getDefaultSectionData(sectionKey),
      })
      existing.set(key, true)
    }
  }

  return expanded
}

export function loadBaselineSeedFromRepo() {
  const seedPath = resolveBaselineSeedPath()
  if (!fs.existsSync(seedPath)) {
    const err = new Error(`[baseline-seed] Seed file missing at ${seedPath}`)
    err.code = 'SEED_FILE_MISSING'
    throw err
  }
  const payload = JSON.parse(fs.readFileSync(seedPath, 'utf8'))
  const profiles = Array.isArray(payload?.profiles) ? payload.profiles : []
  const sections = expandDefaultProfileSections(
    profiles,
    Array.isArray(payload?.sections) ? payload.sections : [],
  )
  const organizations = Array.isArray(payload?.organizations) ? payload.organizations : []
  const opportunities = Array.isArray(payload?.funding_opportunities) ? payload.funding_opportunities : []
  const grants = Array.isArray(payload?.grants) ? payload.grants : []
  const documents = Array.isArray(payload?.documents) ? payload.documents : []
  const profileDocuments = Array.isArray(payload?.profile_documents) ? payload.profile_documents : []

  return {
    exported_at: payload?.exported_at ?? null,
    seedPath,
    profiles,
    sections,
    organizations,
    opportunities,
    grants,
    documents,
    profileDocuments,
  }
}

export async function seedBaselineFromRepo(db, opts = {}) {
  const {
    // Auto-seed only when DB appears empty-ish.
    mode = 'auto', // 'auto' | 'force' | 'off'
    seedOpportunitiesIfEmpty = true,
    seedGrantsIfEmpty = true,
    seedDocumentsIfEmpty = true,
  } = opts

  if (mode === 'off') {
    return { ok: true, skipped: true, reason: 'mode_off' }
  }

  const seed = loadBaselineSeedFromRepo()

  const before = {
    profiles: Number((await db.prepare('SELECT COUNT(*) as count FROM profiles').get())?.count || 0),
    sections: Number((await db.prepare('SELECT COUNT(*) as count FROM profile_sections').get())?.count || 0),
    organizations: Number((await db.prepare('SELECT COUNT(*) as count FROM organizations').get())?.count || 0),
    opportunities: Number((await db.prepare('SELECT COUNT(*) as count FROM funding_opportunities').get())?.count || 0),
    grants: Number((await db.prepare('SELECT COUNT(*) as count FROM grants').get())?.count || 0),
    documents: Number((await db.prepare('SELECT COUNT(*) as count FROM documents').get())?.count || 0),
    profile_documents: Number((await db.prepare('SELECT COUNT(*) as count FROM profile_documents').get())?.count || 0),
  }

  const shouldSeedProfiles =
    mode === 'force' || before.profiles < Math.max(1, Math.floor(seed.profiles.length * 0.8))
  const shouldSeedOpportunities =
    seedOpportunitiesIfEmpty && (mode === 'force' || before.opportunities === 0)
  const shouldSeedGrants = seedGrantsIfEmpty && (mode === 'force' || before.grants === 0)
  const shouldSeedDocuments = seedDocumentsIfEmpty && (mode === 'force' || before.documents === 0)

  if (!shouldSeedProfiles && !shouldSeedOpportunities && !shouldSeedGrants && !shouldSeedDocuments) {
    return {
      ok: true,
      skipped: true,
      reason: 'already_seeded',
      seed_path: seed.seedPath,
      exported_at: seed.exported_at,
      before,
    }
  }

  const counts = {
    profiles_upserted: 0,
    sections_upserted: 0,
    organizations_upserted: 0,
    opportunities_upserted: 0,
    grants_upserted: 0,
    documents_upserted: 0,
    profile_documents_upserted: 0,
  }

  const _doSeed = async (tx) => {
    const isPostgres = tx?.dialect === 'postgres'
    await tx.prepare(
      isPostgres
        ? `
          CREATE TABLE IF NOT EXISTS profile_tombstones (
            profile_id TEXT PRIMARY KEY,
            deleted_at TIMESTAMPTZ DEFAULT now(),
            deleted_by TEXT,
            reason TEXT
          )
        `
        : `
          CREATE TABLE IF NOT EXISTS profile_tombstones (
            profile_id TEXT PRIMARY KEY,
            deleted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            deleted_by TEXT,
            reason TEXT
          )
        `,
    ).run()

    let tombstoneRows = []
    try {
      tombstoneRows = await tx.prepare('SELECT profile_id FROM profile_tombstones').all()
    } catch {
      tombstoneRows = []
    }
    const rows = Array.isArray(tombstoneRows) ? tombstoneRows : (tombstoneRows?.rows ?? [])
    const tombstonedProfileIds = new Set(
      rows.map((r) => String(r?.profile_id || '').trim()).filter(Boolean),
    )

    const upsertOrg = tx.prepare(`
      INSERT INTO organizations (
        id, name, email, phone, applicant_type,
        website, ein, mission, address, city, state, zip,
        updated_at
      ) VALUES (
        @id, @name, @email, @phone, @applicant_type,
        @website, @ein, @mission, @address, @city, @state, @zip,
        CURRENT_TIMESTAMP
      )
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        email = excluded.email,
        phone = excluded.phone,
        applicant_type = excluded.applicant_type,
        website = excluded.website,
        ein = excluded.ein,
        mission = excluded.mission,
        address = excluded.address,
        city = excluded.city,
        state = excluded.state,
        zip = excluded.zip,
        updated_at = CURRENT_TIMESTAMP
    `)

    const upsertOpp = tx.prepare(`
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
        contact_info,
        is_national,
        state,
        regions,
        categories,
        keywords,
        opportunity_type,
        type,
        evidence_url,
        last_verified_at,
        requires_501c3,
        requires_match,
        match_percentage,
        is_active,
        last_crawled,
        match_reasons,
        notes,
        profile_id,
        updated_at
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
        @contact_info,
        @is_national,
        @state,
        @regions,
        @categories,
        @keywords,
        @opportunity_type,
        @type,
        @evidence_url,
        @last_verified_at,
        @requires_501c3,
        @requires_match,
        @match_percentage,
        @is_active,
        @last_crawled,
        @match_reasons,
        @notes,
        @profile_id,
        CURRENT_TIMESTAMP
      )
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        sponsor = excluded.sponsor,
        source = excluded.source,
        source_id = excluded.source_id,
        source_url = excluded.source_url,
        record_origin = excluded.record_origin,
        description = excluded.description,
        eligibility_bullets = excluded.eligibility_bullets,
        amount_min = excluded.amount_min,
        amount_max = excluded.amount_max,
        amount_description = excluded.amount_description,
        deadline = excluded.deadline,
        deadline_type = excluded.deadline_type,
        application_url = excluded.application_url,
        contact_info = excluded.contact_info,
        is_national = excluded.is_national,
        state = excluded.state,
        regions = excluded.regions,
        categories = excluded.categories,
        keywords = excluded.keywords,
        opportunity_type = excluded.opportunity_type,
        type = excluded.type,
        evidence_url = excluded.evidence_url,
        last_verified_at = excluded.last_verified_at,
        requires_501c3 = excluded.requires_501c3,
        requires_match = excluded.requires_match,
        match_percentage = excluded.match_percentage,
        is_active = excluded.is_active,
        last_crawled = excluded.last_crawled,
        match_reasons = excluded.match_reasons,
        notes = excluded.notes,
        profile_id = excluded.profile_id,
        updated_at = CURRENT_TIMESTAMP
    `)

    const upsertProfile = tx.prepare(`
      INSERT INTO profiles (
        id, display_name, primary_type, status, tags, avatar_url, organization_id, updated_at
      ) VALUES (
        @id, @display_name, @primary_type, @status, @tags, @avatar_url, @organization_id, CURRENT_TIMESTAMP
      )
      ON CONFLICT(id) DO UPDATE SET
        display_name = excluded.display_name,
        primary_type = excluded.primary_type,
        status = excluded.status,
        tags = excluded.tags,
        -- AVATAR CHURN GUARD: this baseline re-seed runs at boot (selfHeal.js /
        -- server.js) and on-demand from the admin "force" route, re-upserting
        -- EVERY profile in one transaction. The repo seed snapshot does not carry
        -- live avatars (p.avatar_url is almost always null and avatar_data is never
        -- exported), so a plain "avatar_url = excluded.avatar_url" wiped uploaded
        -- avatars across many profiles at one instant. Preserve any existing live
        -- avatar_url and only adopt the seed value when it is a real (non-empty)
        -- string and the row has none. Legitimate avatar replacement still happens
        -- via the dedicated POST /:id/avatar endpoint, which sets the column directly.
        -- (avatar_data BYTEA is intentionally absent from this upsert and is never touched.)
        avatar_url = COALESCE(
          profiles.avatar_url,
          NULLIF(TRIM(COALESCE(excluded.avatar_url, '')), '')
        ),
        organization_id = excluded.organization_id,
        updated_at = CURRENT_TIMESTAMP
      -- Never resurrect profiles that a user/admin explicitly deleted.
      -- (Otherwise "orphaned" seed profiles keep coming back after deletion.)
      WHERE profiles.status IS NULL OR profiles.status <> 'deleted'
    `)

    const upsertSection = tx.prepare(`
      INSERT INTO profile_sections (
        id, profile_id, section_key, data, updated_by, updated_at
      ) VALUES (
        @id, @profile_id, @section_key, @data, 'system-seed', CURRENT_TIMESTAMP
      )
      ON CONFLICT(profile_id, section_key) DO UPDATE SET
        data = excluded.data,
        updated_by = excluded.updated_by,
        updated_at = CURRENT_TIMESTAMP
    `)

    const upsertGrant = tx.prepare(`
      INSERT INTO grants (
        id,
        organization_id,
        funding_opportunity_id,
        title,
        funder,
        amount_requested,
        amount_awarded,
        status,
        deadline,
        submitted_date,
        award_date,
        start_date,
        end_date,
        match_score,
        match_reasons,
        notes,
        application_url,
        portal_url,
        assigned_to,
        priority,
        matcher_version,
        updated_at
      ) VALUES (
        @id,
        @organization_id,
        @funding_opportunity_id,
        @title,
        @funder,
        @amount_requested,
        @amount_awarded,
        @status,
        @deadline,
        @submitted_date,
        @award_date,
        @start_date,
        @end_date,
        @match_score,
        @match_reasons,
        @notes,
        @application_url,
        @portal_url,
        @assigned_to,
        @priority,
        'baseline-seed',
        CURRENT_TIMESTAMP
      )
      ON CONFLICT(id) DO UPDATE SET
        organization_id = excluded.organization_id,
        funding_opportunity_id = excluded.funding_opportunity_id,
        title = excluded.title,
        funder = excluded.funder,
        amount_requested = excluded.amount_requested,
        amount_awarded = excluded.amount_awarded,
        status = excluded.status,
        deadline = excluded.deadline,
        submitted_date = excluded.submitted_date,
        award_date = excluded.award_date,
        start_date = excluded.start_date,
        end_date = excluded.end_date,
        match_score = excluded.match_score,
        match_reasons = excluded.match_reasons,
        notes = excluded.notes,
        application_url = excluded.application_url,
        portal_url = excluded.portal_url,
        assigned_to = excluded.assigned_to,
        priority = excluded.priority,
        matcher_version = excluded.matcher_version,
        updated_at = CURRENT_TIMESTAMP
    `)

    const upsertDoc = tx.prepare(`
      INSERT INTO documents (
        id,
        organization_id,
        grant_id,
        profile_id,
        name,
        type,
        file_url,
        file_path,
        file_size,
        mime_type,
        extracted_text,
        ai_summary,
        ai_sections,
        processing_status,
        processing_error,
        version,
        notes,
        updated_at
      ) VALUES (
        @id,
        @organization_id,
        @grant_id,
        @profile_id,
        @name,
        @type,
        @file_url,
        @file_path,
        @file_size,
        @mime_type,
        @extracted_text,
        @ai_summary,
        @ai_sections,
        @processing_status,
        @processing_error,
        @version,
        @notes,
        CURRENT_TIMESTAMP
      )
      ON CONFLICT(id) DO UPDATE SET
        organization_id = excluded.organization_id,
        grant_id = excluded.grant_id,
        profile_id = excluded.profile_id,
        name = excluded.name,
        type = excluded.type,
        file_url = excluded.file_url,
        file_path = excluded.file_path,
        file_size = excluded.file_size,
        mime_type = excluded.mime_type,
        extracted_text = excluded.extracted_text,
        ai_summary = excluded.ai_summary,
        ai_sections = excluded.ai_sections,
        processing_status = excluded.processing_status,
        processing_error = excluded.processing_error,
        version = excluded.version,
        notes = excluded.notes,
        updated_at = CURRENT_TIMESTAMP
    `)

    const upsertProfileDoc = tx.prepare(`
      INSERT INTO profile_documents (profile_id, document_id)
      VALUES (?, ?)
      ON CONFLICT(profile_id, document_id) DO NOTHING
    `)

    const normalizeId = (value) => {
      const v = String(value ?? '').trim()
      return v ? v : null
    }

    async function selectExistingIds(table, ids) {
      const list = Array.from(ids || []).map(normalizeId).filter(Boolean)
      if (list.length === 0) return new Set()
      const allowed = new Set([
        'organizations',
        'profiles',
        'funding_opportunities',
        'grants',
        'documents',
      ])
      if (!allowed.has(table)) throw new Error(`[baseline-seed] invalid table lookup: ${table}`)
      const placeholders = list.map(() => '?').join(', ')
      const result = await tx.prepare(`SELECT id FROM ${table} WHERE id IN (${placeholders})`).all(...list)
      const resultRows = Array.isArray(result) ? result : (result?.rows ?? [])
      return new Set(resultRows.map((r) => normalizeId(r?.id)).filter(Boolean))
    }

    // FK-safe seeding:
    // Seeding should never hard-fail on missing references (schema drift / partial seed tables).
    // Instead, we either (a) skip the row, or (b) null out the FK when the column allows NULL.
    const referencedOrgIds = new Set(
      [
        ...(seed.organizations || []).map((o) => normalizeId(o?.id)),
        ...(seed.profiles || []).map((p) => normalizeId(p?.organization_id)),
        ...(seed.grants || []).map((g) => normalizeId(g?.organization_id)),
        ...(seed.documents || []).map((d) => normalizeId(d?.organization_id)),
      ].filter(Boolean),
    )
    const referencedProfileIds = new Set(
      [
        ...(seed.profiles || []).map((p) => normalizeId(p?.id)),
        ...(seed.sections || []).map((s) => normalizeId(s?.profile_id)),
        ...(seed.documents || []).map((d) => normalizeId(d?.profile_id)),
        ...(seed.profileDocuments || []).map((l) => normalizeId(l?.profile_id)),
      ].filter(Boolean),
    )
    const referencedOppIds = new Set(
      [
        ...(seed.opportunities || []).map((o) => normalizeId(o?.id)),
        ...(seed.grants || []).map((g) => normalizeId(g?.funding_opportunity_id)),
      ].filter(Boolean),
    )
    const referencedGrantIds = new Set(
      [
        ...(seed.grants || []).map((g) => normalizeId(g?.id)),
        ...(seed.documents || []).map((d) => normalizeId(d?.grant_id)),
      ].filter(Boolean),
    )
    const referencedDocIds = new Set(
      [
        ...(seed.documents || []).map((d) => normalizeId(d?.id)),
        ...(seed.profileDocuments || []).map((l) => normalizeId(l?.document_id)),
      ].filter(Boolean),
    )

    const knownOrgIds = await selectExistingIds('organizations', referencedOrgIds)
    const knownProfileIds = await selectExistingIds('profiles', referencedProfileIds)
    const knownOppIds = await selectExistingIds('funding_opportunities', referencedOppIds)
    const knownGrantIds = await selectExistingIds('grants', referencedGrantIds)
    const knownDocIds = await selectExistingIds('documents', referencedDocIds)

    const fkAdjustments = {
      profiles_null_org: 0,
      sections_skipped_missing_profile: 0,
      grants_skipped_missing_org: 0,
      grants_null_missing_opportunity: 0,
      documents_null_missing_org: 0,
      documents_null_missing_profile: 0,
      documents_null_missing_grant: 0,
      profile_docs_skipped_missing_profile: 0,
      profile_docs_skipped_missing_doc: 0,
    }

    if (shouldSeedProfiles) {
      for (const org of seed.organizations) {
        if (!org?.id || !org?.name) continue
        await upsertOrg.run({
          id: org.id,
          name: org.name,
          email: org.email ?? null,
          phone: org.phone ?? null,
          applicant_type: normalizeApplicantType(org.applicant_type),
          website: org.website ?? null,
          ein: org.ein ?? null,
          mission: org.mission ?? null,
          address: org.address ?? null,
          city: org.city ?? null,
          state: org.state ?? null,
          zip: org.zip ?? null,
        })
        knownOrgIds.add(String(org.id).trim())
        counts.organizations_upserted++
      }

      for (const p of seed.profiles) {
        if (!p?.id || !p?.display_name) continue
        const profileId = String(p.id).trim()
        if (tombstonedProfileIds.has(profileId)) {
          console.warn('[seedBaselineFromRepo] Skipping tombstoned profile', { profile_id: profileId })
          continue
        }
        const desiredOrgId = normalizeId(p.organization_id)
        const safeOrgId = desiredOrgId && knownOrgIds.has(desiredOrgId) ? desiredOrgId : null
        if (desiredOrgId && !safeOrgId) fkAdjustments.profiles_null_org++
        await upsertProfile.run({
          id: profileId,
          display_name: p.display_name,
          primary_type: p.primary_type ?? null,
          status: p.status ?? 'active',
          tags: safeJsonString(p.tags, '[]'),
          avatar_url: p.avatar_url ?? null,
          organization_id: safeOrgId,
        })
        knownProfileIds.add(profileId)
        counts.profiles_upserted++
      }

      for (const s of seed.sections) {
        if (!s?.profile_id || !s?.section_key) continue
        const profileId = String(s.profile_id).trim()
        if (tombstonedProfileIds.has(profileId)) continue
        if (!knownProfileIds.has(profileId)) {
          fkAdjustments.sections_skipped_missing_profile++
          continue
        }
        await upsertSection.run({
          id: crypto.randomUUID(),
          profile_id: profileId,
          section_key: s.section_key,
          data: typeof s.data === 'string' ? s.data : safeJsonString(s.data, '{}'),
        })
        counts.sections_upserted++
      }
    }

    if (shouldSeedOpportunities) {
      for (const o of seed.opportunities) {
        if (!o?.id || !o?.title) continue
        await upsertOpp.run({
          id: o.id,
          title: o.title,
          sponsor: o.sponsor ?? null,
          source: o.source ?? 'baseline_seed',
          source_id: o.source_id ?? o.id,
          source_url: o.source_url ?? o.url ?? null,
          record_origin: normalizeRecordOrigin(o.record_origin),
          description: o.description ?? null,
          eligibility_bullets: safeJsonString(o.eligibility_bullets, '[]'),
          amount_min: o.amount_min ?? null,
          amount_max: o.amount_max ?? null,
          amount_description: o.amount_description ?? null,
          deadline: o.deadline ?? null,
          deadline_type: o.deadline_type ?? null,
          application_url: o.application_url ?? null,
          contact_info: o.contact_info ? safeJsonString(o.contact_info, '{}') : null,
          is_national: coerceBoolInt(o.is_national, 0),
          state: o.state ?? null,
          regions: safeJsonString(o.regions, '[]'),
          categories: safeJsonString(o.categories, '[]'),
          keywords: safeJsonString(o.keywords, '[]'),
          opportunity_type: o.opportunity_type ?? null,
          type: o.type ?? 'OPPORTUNITY',
          evidence_url: o.evidence_url ?? null,
          last_verified_at: o.last_verified_at ?? null,
          requires_501c3: coerceBoolInt(o.requires_501c3, 0),
          requires_match: coerceBoolInt(o.requires_match, 0),
          match_percentage: o.match_percentage ?? null,
          is_active: coerceBoolInt(o.is_active, 1),
          last_crawled: o.last_crawled ?? null,
          match_reasons: safeJsonString(o.match_reasons, '[]'),
          notes: o.notes ?? null,
          profile_id: o.profile_id ?? null,
        })
        knownOppIds.add(String(o.id).trim())
        counts.opportunities_upserted++
      }
    }

    if (shouldSeedGrants) {
      for (const g of seed.grants) {
        if (!g?.id || !g?.title) continue
        const orgId = normalizeId(g.organization_id)
        if (orgId && !knownOrgIds.has(orgId)) {
          fkAdjustments.grants_skipped_missing_org++
          continue
        }
        const desiredOppId = normalizeId(g.funding_opportunity_id)
        const safeOppId =
          desiredOppId && knownOppIds.has(desiredOppId) ? desiredOppId : null
        if (desiredOppId && !safeOppId) fkAdjustments.grants_null_missing_opportunity++
        await upsertGrant.run({
          id: g.id,
          organization_id: orgId ?? null,
          funding_opportunity_id: safeOppId,
          title: g.title,
          funder: g.funder ?? null,
          amount_requested: g.amount_requested ?? null,
          amount_awarded: g.amount_awarded ?? null,
          status: normalizeGrantStatus(g.status),
          deadline: g.deadline ?? null,
          submitted_date: g.submitted_date ?? null,
          award_date: g.award_date ?? null,
          start_date: g.start_date ?? null,
          end_date: g.end_date ?? null,
          match_score: g.match_score ?? null,
          match_reasons: safeJsonString(g.match_reasons, '[]'),
          notes: g.notes ?? null,
          application_url: g.application_url ?? null,
          portal_url: g.portal_url ?? null,
          assigned_to: g.assigned_to ?? null,
          priority: g.priority ?? null,
        })
        knownGrantIds.add(String(g.id).trim())
        counts.grants_upserted++
      }
    }

    if (shouldSeedDocuments) {
      for (const d of seed.documents) {
        if (!d?.id || !d?.name) continue
        const desiredOrgId = normalizeId(d.organization_id)
        const safeOrgId = desiredOrgId && knownOrgIds.has(desiredOrgId) ? desiredOrgId : null
        if (desiredOrgId && !safeOrgId) fkAdjustments.documents_null_missing_org++

        const desiredProfileId = normalizeId(d.profile_id)
        const safeProfileId =
          desiredProfileId && knownProfileIds.has(desiredProfileId) ? desiredProfileId : null
        if (desiredProfileId && !safeProfileId) fkAdjustments.documents_null_missing_profile++

        const desiredGrantId = normalizeId(d.grant_id)
        const safeGrantId = desiredGrantId && knownGrantIds.has(desiredGrantId) ? desiredGrantId : null
        if (desiredGrantId && !safeGrantId) fkAdjustments.documents_null_missing_grant++

        const payload = {
          id: d.id,
          organization_id: safeOrgId,
          grant_id: safeGrantId,
          profile_id: safeProfileId,
          name: d.name,
          type: d.type ?? null,
          file_url: d.file_url ?? null,
          file_path: d.file_path ?? null,
          file_size: d.file_size ?? null,
          mime_type: d.mime_type ?? null,
          extracted_text: d.extracted_text ?? null,
          ai_summary: d.ai_summary ?? null,
          ai_sections: d.ai_sections ?? null,
          processing_status: d.processing_status ?? null,
          processing_error: d.processing_error ?? null,
          version: d.version ?? 1,
          notes: d.notes ?? null,
        }
        try {
          await upsertDoc.run(payload)
        } catch (error) {
          const msg = String(error?.message || error)
          if (msg.includes('documents_status_check')) {
            await upsertDoc.run(payload)
          } else {
            throw error
          }
        }
        knownDocIds.add(String(d.id).trim())
        counts.documents_upserted++
      }

      for (const link of seed.profileDocuments) {
        if (!link?.profile_id || !link?.document_id) continue
        const profileId = String(link.profile_id).trim()
        if (tombstonedProfileIds.has(profileId)) continue
        const docId = String(link.document_id).trim()
        if (!knownProfileIds.has(profileId)) {
          fkAdjustments.profile_docs_skipped_missing_profile++
          continue
        }
        if (!knownDocIds.has(docId)) {
          fkAdjustments.profile_docs_skipped_missing_doc++
          continue
        }
        await upsertProfileDoc.run(profileId, docId)
        counts.profile_documents_upserted++
      }
    }

    // Log FK adjustments if we had to relax/skip anything.
    const hadAdjustments = Object.values(fkAdjustments).some((v) => Number(v) > 0)
    if (hadAdjustments) {
      console.info('[seedBaselineFromRepo] FK adjustments applied', fkAdjustments)
    }
  }

  await db.withTransaction(async (tx) => { await _doSeed(tx) })

  const after = {
    profiles: Number((await db.prepare('SELECT COUNT(*) as count FROM profiles').get())?.count || 0),
    sections: Number((await db.prepare('SELECT COUNT(*) as count FROM profile_sections').get())?.count || 0),
    organizations: Number((await db.prepare('SELECT COUNT(*) as count FROM organizations').get())?.count || 0),
    opportunities: Number((await db.prepare('SELECT COUNT(*) as count FROM funding_opportunities').get())?.count || 0),
    grants: Number((await db.prepare('SELECT COUNT(*) as count FROM grants').get())?.count || 0),
    documents: Number((await db.prepare('SELECT COUNT(*) as count FROM documents').get())?.count || 0),
    profile_documents: Number((await db.prepare('SELECT COUNT(*) as count FROM profile_documents').get())?.count || 0),
  }

  return {
    ok: true,
    skipped: false,
    seed_path: seed.seedPath,
    exported_at: seed.exported_at,
    mode,
    decisions: {
      profiles: shouldSeedProfiles,
      opportunities: shouldSeedOpportunities,
      grants: shouldSeedGrants,
      documents: shouldSeedDocuments,
    },
    before,
    after,
    counts,
  }
}
