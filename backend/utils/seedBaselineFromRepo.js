import fs from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import crypto from 'crypto'

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
  const allowed = new Set(['live_crawl', 'curated_verified', 'manual', 'synthetic'])
  return allowed.has(v) ? v : 'curated_verified'
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
  const sections = Array.isArray(payload?.sections) ? payload.sections : []
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

  await db.withTransaction(async (tx) => {
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
        avatar_url = excluded.avatar_url,
        organization_id = excluded.organization_id,
        updated_at = CURRENT_TIMESTAMP
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
        status,
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
        @status,
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
        status = excluded.status,
        version = excluded.version,
        notes = excluded.notes,
        updated_at = CURRENT_TIMESTAMP
    `)

    const upsertProfileDoc = tx.prepare(`
      INSERT INTO profile_documents (profile_id, document_id)
      VALUES (?, ?)
      ON CONFLICT(profile_id, document_id) DO NOTHING
    `)

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
        counts.organizations_upserted++
      }

      for (const p of seed.profiles) {
        if (!p?.id || !p?.display_name) continue
        await upsertProfile.run({
          id: p.id,
          display_name: p.display_name,
          primary_type: p.primary_type ?? null,
          status: p.status ?? 'active',
          tags: safeJsonString(p.tags, '[]'),
          avatar_url: p.avatar_url ?? null,
          organization_id: p.organization_id ?? null,
        })
        counts.profiles_upserted++
      }

      for (const s of seed.sections) {
        if (!s?.profile_id || !s?.section_key) continue
        await upsertSection.run({
          id: crypto.randomUUID(),
          profile_id: s.profile_id,
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
        counts.opportunities_upserted++
      }
    }

    if (shouldSeedGrants) {
      for (const g of seed.grants) {
        if (!g?.id || !g?.title) continue
        await upsertGrant.run({
          id: g.id,
          organization_id: g.organization_id ?? null,
          funding_opportunity_id: g.funding_opportunity_id ?? null,
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
        counts.grants_upserted++
      }
    }

    if (shouldSeedDocuments) {
      for (const d of seed.documents) {
        if (!d?.id || !d?.name) continue
        await upsertDoc.run({
          id: d.id,
          organization_id: d.organization_id ?? null,
          grant_id: d.grant_id ?? null,
          profile_id: d.profile_id ?? null,
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
          status: d.status ?? null,
          version: d.version ?? 1,
          notes: d.notes ?? null,
        })
        counts.documents_upserted++
      }

      for (const link of seed.profileDocuments) {
        if (!link?.profile_id || !link?.document_id) continue
        await upsertProfileDoc.run(link.profile_id, link.document_id)
        counts.profile_documents_upserted++
      }
    }
  })

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

