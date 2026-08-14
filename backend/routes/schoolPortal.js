/**
 * schoolPortal.js
 *
 * Public-facing API the school's student-information system calls to
 * (a) push student records into GrantFlow profiles and
 * (b) read back the funding sources the matcher says each student is
 * eligible for.
 *
 * Mission alignment:
 *   - Goal 1 / 2 / 3: matches come from the canonical matcher, scored on
 *     the merged profile (school data + anything the student already
 *     entered). No separate "school-only" matching path.
 *   - Goal 4: support all user types — students get first-class treatment.
 *   - Goal 7 / 10: the school portal can render a real funding list for
 *     each student, deep-linked back to the official source.
 *   - Goal 8 / 9: audit signal `school_provided_data: true` is set on
 *     every merged section so it's clear where the data came from; the
 *     matcher response includes the same explainable reason codes.
 *
 * Endpoints (all require `Authorization: Bearer <api_key>`):
 *   GET    /api/school-portal/me
 *   POST   /api/school-portal/students/sync
 *   GET    /api/school-portal/students/:external_student_id
 *   GET    /api/school-portal/students/:external_student_id/matches
 *   POST   /api/school-portal/students/:external_student_id/revoke
 *
 * Admin endpoints (require existing GrantFlow admin auth):
 *   POST   /api/school-portal/admin/partners
 *   POST   /api/school-portal/admin/partners/:id/api-keys
 *   POST   /api/school-portal/admin/partners/:id/api-keys/:keyId/revoke
 *   GET    /api/school-portal/admin/partners
 */
import { Router } from 'express'
import crypto from 'node:crypto'
import {
  generateApiKey,
  hashApiKey,
  requireSchoolPartner,
} from '../middleware/schoolPortalAuth.js'
import {
  mergeSchoolStudentRecord,
  buildProfilePatch,
} from '../services/schoolPortalMerger.js'
import { matchOpportunities } from '../services/matchEngine.js'

const router = Router()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function nowISO() { return new Date().toISOString() }

function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback
  if (typeof value === 'object') return value
  try { return JSON.parse(String(value)) } catch { return fallback }
}

async function loadProfile(db, profileId) {
  const profile = await db
    .prepare('SELECT * FROM profiles WHERE id = ? LIMIT 1')
    .get(profileId)
  if (!profile) return null
  const sections = await db
    .prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?')
    .all(profileId)
  const sectionMap = {}
  for (const row of sections) {
    sectionMap[row.section_key] = parseJson(row.data, {})
  }
  return {
    ...profile,
    tags: parseJson(profile.tags, []),
    sections: sectionMap,
  }
}

async function loadActiveOpportunities(db) {
  return await db
    .prepare(
      `SELECT * FROM funding_opportunities
         WHERE COALESCE(status, 'active') = 'active'
         LIMIT 500`,
    )
    .all()
}

async function findLink(db, partnerId, externalId) {
  return await db
    .prepare(`SELECT * FROM school_student_links
                WHERE school_partner_id = ? AND external_student_id = ?
                LIMIT 1`)
    .get(partnerId, externalId)
}

function isAdminRequest(req) {
  return req.ctx?.isAdmin === true
}

// ---------------------------------------------------------------------------
// Public partner endpoints
// ---------------------------------------------------------------------------
router.get('/me', requireSchoolPartner, async (req, res) => {
  const { id, slug, name, allowed_origins } = req.schoolPartner
  const linkCount = await req.db
    .prepare('SELECT COUNT(*) AS c FROM school_student_links WHERE school_partner_id = ?')
    .get(id)
  return res.json({
    ok: true,
    partner: { id, slug, name, allowed_origins },
    api_key: req.schoolPartnerApiKey,
    student_link_count: linkCount?.c ?? 0,
  })
})

/**
 * POST /api/school-portal/students/sync
 *
 * Body: either a single record or { students: [...] }.
 * Each record must include `external_student_id` (or `student_id` / `id`).
 * Other fields are best-effort — see schoolPortalMerger.js for the canonical
 * mapping.
 */
router.post('/students/sync', requireSchoolPartner, async (req, res) => {
  const body = req.body ?? {}
  const records = Array.isArray(body.students)
    ? body.students
    : Array.isArray(body) ? body : [body]

  if (!records.length) {
    return res.status(400).json({
      ok: false,
      error: 'No student records supplied.',
      code: 'EMPTY_PAYLOAD',
    })
  }

  const results = []
  const failures = []
  for (const record of records) {
    try {
      const result = await mergeSchoolStudentRecord({
        db: req.db,
        partner: req.schoolPartner,
        record,
        actor: `school-portal:${req.schoolPartner.slug}`,
      })
      results.push(result)
    } catch (err) {
      failures.push({
        external_student_id: record?.external_student_id ?? record?.student_id ?? null,
        error: err?.message ?? String(err),
        code: err?.code ?? 'MERGE_FAILED',
      })
    }
  }

  return res.json({
    ok: failures.length === 0,
    partner: { id: req.schoolPartner.id, slug: req.schoolPartner.slug },
    received: records.length,
    succeeded: results.length,
    failed: failures.length,
    results,
    failures,
    synced_at: nowISO(),
  })
})

/**
 * GET /api/school-portal/students/:external_student_id
 *
 * Returns the merged GrantFlow view of this student so the school portal
 * can show "what GrantFlow sees" for transparency.
 *
 * CONSENT IS ENFORCED ON EVERY READ OF THE STUDENT'S DATA, not just on
 * /matches. A revoked link previously still served the FULL merged profile —
 * every `profile_sections` row (financial, health, demographics) — because only
 * the /matches route checked `consent_status`. Revocation that does not stop
 * the partner reading the record is not revocation. The LINK itself is still
 * returned (it is the partner's own bookkeeping, and it is how the school sees
 * that the student revoked); only the student's profile content is withheld.
 */
router.get('/students/:external_student_id', requireSchoolPartner, async (req, res) => {
  const externalId = String(req.params.external_student_id || '').trim()
  if (!externalId) return res.status(400).json({ ok: false, error: 'external_student_id required' })

  const link = await findLink(req.db, req.schoolPartner.id, externalId)
  if (!link) return res.status(404).json({ ok: false, error: 'Student not linked.' })

  const consentRevoked = link.consent_status === 'revoked'
  if (consentRevoked) {
    return res.json({
      ok: true,
      code: 'CONSENT_REVOKED',
      link: {
        id: link.id,
        external_student_id: link.external_student_id,
        profile_id: link.profile_id,
        consent_status: link.consent_status,
        consented_at: link.consented_at,
        revoked_at: link.revoked_at,
        last_synced_at: link.last_synced_at,
      },
      profile: null,
      profile_withheld: 'Student has revoked consent for school-portal sharing.',
    })
  }

  const profile = link.profile_id ? await loadProfile(req.db, link.profile_id) : null
  return res.json({
    ok: true,
    link: {
      id: link.id,
      external_student_id: link.external_student_id,
      profile_id: link.profile_id,
      consent_status: link.consent_status,
      consented_at: link.consented_at,
      revoked_at: link.revoked_at,
      last_synced_at: link.last_synced_at,
    },
    profile: profile ? {
      id: profile.id,
      display_name: profile.display_name,
      primary_type: profile.primary_type,
      tags: profile.tags,
      sections: profile.sections,
    } : null,
  })
})

/**
 * GET /api/school-portal/students/:external_student_id/matches
 *
 * Runs the canonical matcher against the merged profile and returns the
 * scored opportunities. Schools render their own UI from this.
 */
router.get('/students/:external_student_id/matches', requireSchoolPartner, async (req, res) => {
  const externalId = String(req.params.external_student_id || '').trim()
  const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 25))

  const link = await findLink(req.db, req.schoolPartner.id, externalId)
  if (!link) return res.status(404).json({ ok: false, error: 'Student not linked.' })
  if (link.consent_status === 'revoked') {
    return res.status(403).json({
      ok: false,
      error: 'Student has revoked consent for school-portal sharing.',
      code: 'CONSENT_REVOKED',
    })
  }
  if (!link.profile_id) {
    return res.status(404).json({ ok: false, error: 'No profile linked yet.' })
  }

  const profile = await loadProfile(req.db, link.profile_id)
  if (!profile) {
    return res.status(404).json({ ok: false, error: 'Linked profile not found.' })
  }

  const opportunities = await loadActiveOpportunities(req.db)
  const scored = matchOpportunities(profile, opportunities)
  const list = Array.isArray(scored) ? scored : (scored?.matches || scored?.opportunities || [])

  const items = list
    .filter((m) => (m.score ?? 0) > 0)
    .slice(0, limit)
    .map((m) => ({
      id: m.id,
      title: m.title || m.name,
      funder_name: m.funder_name || m.organization_name,
      url: m.url || m.application_url || m.source_url,
      amount_min: m.amount_min,
      amount_max: m.amount_max,
      deadline: m.deadline || m.deadline_date,
      score: m.score,
      reasons: m.reasons || [],
      match_explain: m.match_explain || null,
    }))

  return res.json({
    ok: true,
    partner: { id: req.schoolPartner.id, slug: req.schoolPartner.slug },
    student: {
      external_student_id: externalId,
      profile_id: profile.id,
      display_name: profile.display_name,
    },
    total_found: list.length,
    included: items.length,
    matches: items,
    generated_at: nowISO(),
  })
})

/**
 * POST /api/school-portal/students/:external_student_id/revoke
 *
 * Allow a student (via the school) to revoke the bridge.
 */
router.post('/students/:external_student_id/revoke', requireSchoolPartner, async (req, res) => {
  const externalId = String(req.params.external_student_id || '').trim()
  const link = await findLink(req.db, req.schoolPartner.id, externalId)
  if (!link) return res.status(404).json({ ok: false, error: 'Student not linked.' })

  await req.db
    .prepare(`UPDATE school_student_links
                SET consent_status = 'revoked',
                    revoked_at = ?,
                    updated_at = ?
              WHERE id = ?`)
    .run(nowISO(), nowISO(), link.id)
  return res.json({ ok: true, revoked: true, link_id: link.id })
})

// ---------------------------------------------------------------------------
// Admin endpoints (existing GrantFlow admin auth required)
// ---------------------------------------------------------------------------
function requireAdmin(req, res, next) {
  if (!isAdminRequest(req)) {
    return res.status(403).json({ ok: false, error: 'Admin only.' })
  }
  return next()
}

router.post('/admin/partners', requireAdmin, async (req, res) => {
  const { slug, name, ein, ipeds_id, contact_name, contact_email, allowed_origins, metadata } = req.body ?? {}
  if (!slug || !name) {
    return res.status(400).json({ ok: false, error: 'slug + name required' })
  }
  const id = crypto.randomUUID()
  try {
    await req.db
      .prepare(`INSERT INTO school_partners (
                  id, slug, name, ein, ipeds_id, contact_name, contact_email,
                  allowed_origins, metadata
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        id,
        String(slug).trim().toLowerCase(),
        String(name).trim(),
        ein ?? null,
        ipeds_id ?? null,
        contact_name ?? null,
        contact_email ?? null,
        JSON.stringify(Array.isArray(allowed_origins) ? allowed_origins : []),
        JSON.stringify(metadata ?? {}),
      )
  } catch (err) {
    if (String(err?.message || '').toLowerCase().includes('unique')) {
      return res.status(409).json({ ok: false, error: 'slug already exists.' })
    }
    throw err
  }
  return res.status(201).json({
    ok: true,
    partner: { id, slug, name },
    next_step: `POST /api/school-portal/admin/partners/${id}/api-keys`,
  })
})

router.get('/admin/partners', requireAdmin, async (req, res) => {
  const rows = await req.db
    .prepare(`SELECT id, slug, name, status, contact_email, created_at,
                     (SELECT COUNT(*) FROM school_student_links l WHERE l.school_partner_id = p.id) AS student_count,
                     (SELECT COUNT(*) FROM school_partner_api_keys k WHERE k.school_partner_id = p.id AND k.revoked_at IS NULL) AS active_keys
                FROM school_partners p
                ORDER BY created_at DESC`)
    .all()
  return res.json({ ok: true, partners: rows })
})

router.post('/admin/partners/:id/api-keys', requireAdmin, async (req, res) => {
  const partnerId = req.params.id
  const partner = await req.db
    .prepare('SELECT id FROM school_partners WHERE id = ? LIMIT 1')
    .get(partnerId)
  if (!partner) return res.status(404).json({ ok: false, error: 'Partner not found.' })

  const { label, expires_in_days } = req.body ?? {}
  const key = generateApiKey()
  const expiresAt = expires_in_days
    ? new Date(Date.now() + Number(expires_in_days) * 86400 * 1000).toISOString()
    : null

  const id = crypto.randomUUID()
  await req.db
    .prepare(`INSERT INTO school_partner_api_keys (
                id, school_partner_id, key_hash, key_prefix, label, created_by, expires_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(
      id, partnerId, key.hash, key.prefix,
      label ?? null,
      req.user?.id ?? null,
      expiresAt,
    )

  // The raw key is returned ONCE — we only ever store the hash afterwards.
  return res.status(201).json({
    ok: true,
    api_key: {
      id,
      raw: key.raw,
      prefix: key.prefix,
      label,
      expires_at: expiresAt,
    },
    note: 'Store this key securely — you will not be able to retrieve it again.',
  })
})

router.post('/admin/partners/:id/api-keys/:keyId/revoke', requireAdmin, async (req, res) => {
  const { id: partnerId, keyId } = req.params
  const result = await req.db
    .prepare(`UPDATE school_partner_api_keys
                SET revoked_at = ?
              WHERE id = ? AND school_partner_id = ?`)
    .run(nowISO(), keyId, partnerId)
  return res.json({ ok: true, revoked: result?.changes ?? null })
})

// ---------------------------------------------------------------------------
// Test exports
// ---------------------------------------------------------------------------
export { hashApiKey, generateApiKey, buildProfilePatch }
export default router
