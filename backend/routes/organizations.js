import express from 'express';
import crypto from 'crypto';
import { safeParseJSON } from '../utils/safeJson.js';
import { validatePagination, validateRequiredFields, sanitizeColumns } from '../utils/validation.js';
import { formatError } from '../middleware/errorHandler.js';
import { ensureAuth } from '../middleware/auth.js';
import { mutationRateLimiter } from '../middleware/rateLimiting.js';
import {
  CANONICAL_SECTION_DEFAULTS,
  canonicalSectionKeys,
} from '../prompts/profileSections.js'
import { COMPREHENSIVE_APPLICATION_DEFAULTS } from '../config/comprehensiveApplicationSchema.js'
import { getAccessibleOrganizationIds, isAdminUser, ensureOrganizationAccess, requireAuthenticatedUser } from '../utils/accessControl.js'

const router = express.Router();
router.use(ensureAuth); // Apply auth to all routes

// Whitelist of allowed columns for UPDATE operations
const ALLOWED_ORGANIZATION_COLUMNS = new Set([
  'name', 'email', 'phone', 'city', 'state', 'zip', 'address',
  'applicant_type', 'mission', 'funding_amount_needed', 'website',
  'keywords', 'focus_areas', 'program_areas', 'government_assistance',
  'disabilities', 'target_colleges', 'federal_registrations', 'financial_challenges',
  'veteran', 'disabled', 'first_generation', 'snap_recipient', 'ssi_recipient', 'tanf_recipient'
]);

async function ensureProfileForOrganization(db, { organizationId, displayName, primaryType, userId, createdBy }) {
  const existing = await db
    .prepare(
      `
        SELECT id
        FROM profiles
        WHERE organization_id = ?
        ORDER BY created_at ASC
        LIMIT 1
      `,
    )
    .get(organizationId)

  if (existing?.id) return existing.id

  const profileId = crypto.randomUUID()
  await db
    .prepare(
      `
        INSERT INTO profiles (
          id,
          user_id,
          display_name,
          primary_type,
          status,
          tags,
          organization_id,
          created_by,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, 'active', '[]', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `,
    )
    .run(
      profileId,
      userId ?? null,
      displayName ?? 'New Profile',
      primaryType ?? null,
      organizationId,
      createdBy ?? null,
    )

  return profileId
}

function normalizeEmailField(value) {
  if (!value) return ''
  if (Array.isArray(value)) {
    const first = value.find((v) => typeof v === 'string' && v.trim())
    return first ? first.trim() : ''
  }
  if (typeof value === 'string') return value.trim()
  return ''
}

function normalizePhoneField(value) {
  if (!value) return ''
  if (Array.isArray(value)) {
    const first = value.find((v) => typeof v === 'string' && v.trim())
    return first ? first.trim() : ''
  }
  if (typeof value === 'string') return value.trim()
  return ''
}

async function ensureCanonicalSections(db, profileId, updatedBy = 'org-sync') {
  const sql =
    db?.dialect === 'postgres'
      ? `
          INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
          VALUES (?, ?, ?, ?)
          ON CONFLICT (profile_id, section_key) DO NOTHING
        `
      : `
          INSERT OR IGNORE INTO profile_sections (profile_id, section_key, data, updated_by)
          VALUES (?, ?, ?, ?)
        `
  const insert = db.prepare(sql)
  for (const sectionKey of canonicalSectionKeys) {
    try {
      const defaults = CANONICAL_SECTION_DEFAULTS[sectionKey] ?? {}
      insert.run(profileId, sectionKey, JSON.stringify(defaults), updatedBy)
    } catch (error) {
      console.error(`Failed to insert profile section ${sectionKey}:`, error)
      throw error
    }
  }
}

async function upsertProfileSection(db, profileId, sectionKey, data, updatedBy = 'org-sync') {
  const sql =
    db?.dialect === 'postgres'
      ? `
          INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
          VALUES (?, ?, ?, ?)
          ON CONFLICT (profile_id, section_key) DO UPDATE SET
            data = excluded.data,
            updated_by = excluded.updated_by,
            updated_at = CURRENT_TIMESTAMP
        `
      : `
          INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(profile_id, section_key) DO UPDATE SET
            data = excluded.data,
            updated_by = excluded.updated_by,
            updated_at = CURRENT_TIMESTAMP
        `
  try {
    db.prepare(sql).run(profileId, sectionKey, JSON.stringify(data ?? {}), updatedBy)
  } catch (error) {
    console.error(`Failed to upsert profile section ${sectionKey}:`, error)
    throw error
  }
}

async function syncOrganizationToProfileSections(db, { organizationId, orgRow, payload, actor }) {
  const profileId = await ensureProfileForOrganization(db, {
    organizationId,
    displayName: orgRow?.name ?? payload?.name ?? 'Profile',
    primaryType: orgRow?.applicant_type ?? payload?.applicant_type ?? null,
    userId: actor?.userId ?? null,
    createdBy: actor?.userId ?? actor?.email ?? null,
  })

  await ensureCanonicalSections(db, profileId, 'org-sync')

  const comprehensive = { ...COMPREHENSIVE_APPLICATION_DEFAULTS, ...(payload && typeof payload === 'object' ? payload : {}) }
  await upsertProfileSection(db, profileId, 'comprehensive_application', comprehensive, 'org-sync')

  // Also hydrate key canonical sections (so matchers that read them directly keep working).
  await upsertProfileSection(
    db,
    profileId,
    'basic_information',
    {
      ...CANONICAL_SECTION_DEFAULTS.basic_information,
      full_name: payload?.name ?? orgRow?.name ?? '',
      email: normalizeEmailField(payload?.email ?? orgRow?.email),
      phone: normalizePhoneField(payload?.phone ?? orgRow?.phone),
      website: payload?.website ?? orgRow?.website ?? '',
      address: payload?.address ?? orgRow?.address ?? '',
      city: payload?.city ?? orgRow?.city ?? '',
      state: payload?.state ?? orgRow?.state ?? '',
      zip: payload?.zip ?? orgRow?.zip ?? '',
      date_of_birth: payload?.date_of_birth ?? '',
      age: payload?.age ?? null,
      notes: orgRow?.notes ?? '',
    },
    'org-sync',
  )

  await upsertProfileSection(
    db,
    profileId,
    'organization_details',
    {
      ...CANONICAL_SECTION_DEFAULTS.organization_details,
      organization_type: payload?.applicant_type === 'organization' ? 'organization' : payload?.applicant_type ?? '',
      ein: payload?.organization_ein ?? orgRow?.ein ?? '',
      uei: payload?.organization_uei ?? orgRow?.uei ?? '',
      cage_code: payload?.organization_cage_code ?? orgRow?.cage_code ?? '',
      annual_budget: payload?.annual_budget ?? orgRow?.annual_budget ?? null,
      staff_count: payload?.staff_count ?? orgRow?.staff_count ?? null,
      mission: payload?.mission ?? orgRow?.mission ?? '',
      city: payload?.city ?? orgRow?.city ?? '',
      state: payload?.state ?? orgRow?.state ?? '',
      zip: payload?.zip ?? orgRow?.zip ?? '',
    },
    'org-sync',
  )

  await upsertProfileSection(
    db,
    profileId,
    'financial_information',
    {
      ...CANONICAL_SECTION_DEFAULTS.financial_information,
      household_income: payload?.household_income ?? orgRow?.household_income ?? null,
      household_size: payload?.household_size ?? orgRow?.household_size ?? null,
      financial_need_level: payload?.financial_need_level ?? orgRow?.financial_need_level ?? '',
      low_income: Boolean(payload?.low_income ?? orgRow?.low_income ?? false),
      unemployed: Boolean(payload?.unemployed ?? orgRow?.unemployed ?? false),
      displaced_worker: Boolean(payload?.displaced_worker ?? orgRow?.displaced_worker ?? false),
    },
    'org-sync',
  )

  await upsertProfileSection(
    db,
    profileId,
    'government_assistance',
    {
      ...CANONICAL_SECTION_DEFAULTS.government_assistance,
      medicaid_enrolled: Boolean(payload?.medicaid_enrolled ?? orgRow?.medicaid_enrolled ?? false),
      medicare_recipient: Boolean(payload?.medicare_recipient ?? orgRow?.medicare_recipient ?? false),
      ssi_recipient: Boolean(payload?.ssi_recipient ?? orgRow?.ssi_recipient ?? false),
      ssdi_recipient: Boolean(payload?.ssdi_recipient ?? orgRow?.ssdi_recipient ?? false),
      snap_recipient: Boolean(payload?.snap_recipient ?? orgRow?.snap_recipient ?? false),
      tanf_recipient: Boolean(payload?.tanf_recipient ?? orgRow?.tanf_recipient ?? false),
      section8_housing: Boolean(payload?.section8_housing ?? orgRow?.section8_housing ?? false),
    },
    'org-sync',
  )

  try {
    db
      .prepare('UPDATE profiles SET updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(profileId)
  } catch (error) {
    console.error('Failed to update profile timestamp:', error)
    throw error
  }

  return profileId
}

// List all organizations
router.get('/', ensureAuth, async (req, res) => {
  try {
    const user = requireAuthenticatedUser(req, res)
    if (!user) return

    const { search, state, type } = req.query;
    const { limit, offset } = validatePagination(req.query);
    
    let query = 'SELECT * FROM organizations WHERE 1=1';
    const params = [];

    // Access control: non-admins can only see organizations linked to their profiles.
    if (!isAdminUser(user)) {
      const orgIds = await getAccessibleOrganizationIds(req.db, user)
      if (!orgIds || orgIds.size === 0) {
        return res.json([])
      }
      const placeholders = Array.from(orgIds).map(() => '?').join(', ')
      query += ` AND id IN (${placeholders})`
      params.push(...Array.from(orgIds))
    }
    
    if (search) {
      query += ' AND (name LIKE ? OR email LIKE ? OR city LIKE ?)';
      const searchTerm = `%${search}%`;
      params.push(searchTerm, searchTerm, searchTerm);
    }
    
    if (state) {
      query += ' AND state = ?';
      params.push(state);
    }
    
    if (type) {
      query += ' AND applicant_type = ?';
      params.push(type);
    }
    
    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    
    let orgs;
    try {
      orgs = req.db.prepare(query).all(...params);
    } catch (error) {
      console.error('Database query failed:', error);
      throw error;
    }
    
    // Parse JSON fields safely
    const parsed = orgs.map(org => ({
      ...org,
      keywords: safeParseJSON(org.keywords, []),
      focus_areas: safeParseJSON(org.focus_areas, []),
      program_areas: safeParseJSON(org.program_areas, []),
      government_assistance: safeParseJSON(org.government_assistance, []),
      disabilities: safeParseJSON(org.disabilities, []),
      target_colleges: safeParseJSON(org.target_colleges, []),
      federal_registrations: safeParseJSON(org.federal_registrations, []),
      financial_challenges: safeParseJSON(org.financial_challenges, [])
    }));

    const merged = await Promise.all(
      parsed.map(org => mergeProfileSectionsIntoOrg(req.db, org.id, org))
    );

    res.json(merged);
  } catch (error) {
    console.error('Error listing organizations:', error);
    res.status(500).json(formatError(error));
  }
});

/**
 * Merge profile_sections into organization for assistants (GrantPortalAssistant, AIApplicationAssistant).
 * Profile sections hold the narrative/comprehensive data that the raw organizations table may not have.
 */
async function mergeProfileSectionsIntoOrg(db, orgId, base) {
  const profileRow = db
    .prepare(
      `SELECT id FROM profiles WHERE organization_id = ? ORDER BY created_at ASC LIMIT 1`
    )
    .get(orgId)
  if (!profileRow?.id) return base

  const sectionRows = db
    .prepare(
      `SELECT section_key, data FROM profile_sections WHERE profile_id = ?`
    )
    .all(profileRow.id)

  const sections = {}
  for (const row of sectionRows || []) {
    sections[row.section_key] = safeParseJSON(row.data, {})
  }

  const basic = sections.basic_information ?? {}
  const orgDetails = sections.organization_details ?? {}
  const comprehensive = sections.comprehensive_application ?? {}

  const mergeValue = (a, b) => (b != null && b !== '' && (Array.isArray(b) ? b.length > 0 : true) ? b : a)

  return {
    ...base,
    // basic_information
    email: mergeValue(base.email, normalizeEmailField(basic.email ?? comprehensive.email)),
    phone: mergeValue(base.phone, normalizePhoneField(basic.phone ?? comprehensive.phone)),
    address: mergeValue(base.address, basic.address ?? comprehensive.address),
    city: mergeValue(base.city, basic.city ?? orgDetails.city ?? comprehensive.city),
    state: mergeValue(base.state, basic.state ?? orgDetails.state ?? comprehensive.state),
    zip: mergeValue(base.zip, basic.zip ?? comprehensive.zip ?? comprehensive.postal_code),
    // organization_details
    ein: mergeValue(base.ein, orgDetails.ein ?? comprehensive.organization_ein),
    uei: mergeValue(base.uei, orgDetails.uei ?? comprehensive.organization_uei),
    mission: mergeValue(base.mission, orgDetails.mission ?? comprehensive.mission),
    annual_budget: base.annual_budget ?? orgDetails.annual_budget ?? comprehensive.annual_budget,
    staff_count: base.staff_count ?? orgDetails.staff_count ?? comprehensive.staff_count,
    // comprehensive_application narratives (the main data assistants need)
    primary_goal: comprehensive.primary_goal ?? base.primary_goal ?? '',
    target_population: comprehensive.target_population ?? base.target_population ?? '',
    geographic_focus: comprehensive.geographic_focus ?? base.geographic_focus ?? '',
    funding_amount_needed: comprehensive.funding_amount_needed ?? base.funding_amount_needed ?? '',
    timeline: comprehensive.timeline ?? base.timeline ?? '',
    past_experience: comprehensive.past_experience ?? base.past_experience ?? '',
    unique_qualities: comprehensive.unique_qualities ?? base.unique_qualities ?? '',
    collaboration_partners: comprehensive.collaboration_partners ?? base.collaboration_partners ?? '',
    sustainability_plan: comprehensive.sustainability_plan ?? base.sustainability_plan ?? '',
    barriers_faced: comprehensive.barriers_faced ?? base.barriers_faced ?? '',
    // student fields
    gpa: comprehensive.gpa ?? base.gpa ?? null,
    act_score: comprehensive.act_score ?? base.act_score ?? null,
    sat_score: comprehensive.sat_score ?? base.sat_score ?? null,
    student_grade_level: Array.isArray(comprehensive.student_grade_levels)
      ? comprehensive.student_grade_levels.join(', ')
      : (comprehensive.student_grade_level ?? base.student_grade_level ?? ''),
    intended_major: comprehensive.intended_major ?? base.intended_major ?? '',
    extracurricular_activities: Array.isArray(comprehensive.extracurricular_activities)
      ? comprehensive.extracurricular_activities
      : (base.extracurricular_activities ?? []),
    achievements: Array.isArray(comprehensive.achievements)
      ? comprehensive.achievements
      : (base.achievements ?? []),
    community_service_hours:
      comprehensive.community_service_hours ?? base.community_service_hours ?? null,
    // keywords/focus_areas from comprehensive if org has empty
    keywords:
      Array.isArray(comprehensive.keywords) && comprehensive.keywords.length > 0
        ? comprehensive.keywords
        : base.keywords,
    focus_areas:
      Array.isArray(comprehensive.focus_areas) && comprehensive.focus_areas.length > 0
        ? comprehensive.focus_areas
        : base.focus_areas,
  }
}

// Get single organization
router.get('/:id', ensureAuth, async (req, res) => {
  try {
    if (!(await ensureOrganizationAccess(req, res, req.params.id))) return
    const org = req.db.prepare('SELECT * FROM organizations WHERE id = ?').get(req.params.id);
    
    if (!org) {
      return res.status(404).json({ error: 'Organization not found' });
    }
    
    // Parse JSON fields safely
    const parsed = {
      ...org,
      keywords: safeParseJSON(org.keywords, []),
      focus_areas: safeParseJSON(org.focus_areas, []),
      program_areas: safeParseJSON(org.program_areas, []),
      government_assistance: safeParseJSON(org.government_assistance, []),
      disabilities: safeParseJSON(org.disabilities, []),
      target_colleges: safeParseJSON(org.target_colleges, []),
      federal_registrations: safeParseJSON(org.federal_registrations, []),
      financial_challenges: safeParseJSON(org.financial_challenges, [])
    };

    // Merge profile_sections so assistants (GrantPortalAssistant, AIApplicationAssistant)
    // receive full narrative data (primary_goal, mission, etc.) instead of empty sections.
    const merged = await mergeProfileSectionsIntoOrg(req.db, req.params.id, parsed);
    
    res.json(merged);
  } catch (error) {
    console.error('Error getting organization:', error);
    res.status(500).json(formatError(error));
  }
});

// Create organization
router.post('/', ensureAuth, mutationRateLimiter, async (req, res) => {
  try {
    const data = req.body;
    
    // Validate required fields
    const validation = validateRequiredFields(data, ['name']);
    if (!validation.valid) {
      return res.status(400).json({ 
        error: 'Missing required fields', 
        missingFields: validation.missingFields 
      });
    }
    
    const id = crypto.randomUUID();
    
    // Sanitize columns against whitelist
    const sanitizedData = sanitizeColumns(data, ALLOWED_ORGANIZATION_COLUMNS);
    
    // Stringify JSON fields
    const jsonFields = ['keywords', 'focus_areas', 'program_areas', 'government_assistance', 
                        'disabilities', 'target_colleges', 'federal_registrations', 'financial_challenges'];
    
    jsonFields.forEach(field => {
      if (sanitizedData[field] && Array.isArray(sanitizedData[field])) {
        sanitizedData[field] = JSON.stringify(sanitizedData[field]);
      }
    });
    
    const columns = ['id', ...Object.keys(sanitizedData)];
    const placeholders = columns.map(() => '?').join(', ');
    const values = [id, ...Object.values(sanitizedData)];
    
    req.db.prepare(`
      INSERT INTO organizations (${columns.join(', ')})
      VALUES (${placeholders})
    `).run(...values);
    
    const org = req.db.prepare('SELECT * FROM organizations WHERE id = ?').get(id);

    // Keep profile_sections (and matching/crawlers) in sync with comprehensive application data.
    let profileId = null
    try {
      profileId = await syncOrganizationToProfileSections(req.db, {
        organizationId: id,
        orgRow: org,
        payload: data,
        actor: req.user,
      })
    } catch (syncError) {
      console.warn('[organizations] Failed to sync org -> profile sections:', syncError?.message || syncError)
    }

    res.status(201).json({ ...(org || {}), profile_id: profileId });
  } catch (error) {
    console.error('Error creating organization:', error);
    res.status(500).json(formatError(error));
  }
});

// Update organization
router.put('/:id', ensureAuth, mutationRateLimiter, async (req, res) => {
  try {
    if (!(await ensureOrganizationAccess(req, res, req.params.id))) return
    const data = req.body;
    
    // Sanitize columns against whitelist
    const sanitizedData = sanitizeColumns(data, ALLOWED_ORGANIZATION_COLUMNS);
    
    if (Object.keys(sanitizedData).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }
    
    // Stringify JSON fields
    const jsonFields = ['keywords', 'focus_areas', 'program_areas', 'government_assistance', 
                        'disabilities', 'target_colleges', 'federal_registrations', 'financial_challenges'];
    
    jsonFields.forEach(field => {
      if (sanitizedData[field] && Array.isArray(sanitizedData[field])) {
        sanitizedData[field] = JSON.stringify(sanitizedData[field]);
      }
    });
    
    const setClause = Object.keys(sanitizedData).map(key => `${key} = ?`).join(', ');
    const values = [...Object.values(sanitizedData), req.params.id];
    
    req.db.prepare(`
      UPDATE organizations 
      SET ${setClause}, updated_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `).run(...values);
    
    const org = req.db.prepare('SELECT * FROM organizations WHERE id = ?').get(req.params.id);

    // Keep profile_sections (and matching/crawlers) in sync with comprehensive application data.
    let profileId = null
    try {
      profileId = await syncOrganizationToProfileSections(req.db, {
        organizationId: req.params.id,
        orgRow: org,
        payload: data,
        actor: req.user,
      })
    } catch (syncError) {
      console.warn('[organizations] Failed to sync org -> profile sections:', syncError?.message || syncError)
    }

    res.json({ ...(org || {}), profile_id: profileId });
  } catch (error) {
    console.error('Error updating organization:', error);
    res.status(500).json(formatError(error));
  }
});

// Delete organization (soft delete with deleted_at timestamp)
router.delete('/:id', ensureAuth, mutationRateLimiter, async (req, res) => {
  try {
    if (!(await ensureOrganizationAccess(req, res, req.params.id))) return
    // Check if organization exists
    const org = req.db.prepare('SELECT id FROM organizations WHERE id = ?').get(req.params.id);
    if (!org) {
      return res.status(404).json({ error: 'Organization not found' });
    }
    
    // Soft delete by setting deleted_at (schema-managed; do not attempt runtime ALTER in Postgres)
    req.db.prepare('UPDATE organizations SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);

    // Propagate soft-delete to linked profile so the matcher and Anya skip it
    req.db
      .prepare(`UPDATE profiles SET status = 'deleted', updated_at = CURRENT_TIMESTAMP WHERE organization_id = ?`)
      .run(req.params.id);
    
    res.json({ success: true, message: 'Organization marked as deleted' });
  } catch (error) {
    console.error('Error deleting organization:', error);
    res.status(500).json(formatError(error));
  }
});

// Get organization's grants
router.get('/:id/grants', ensureAuth, async (req, res) => {
  try {
    if (!(await ensureOrganizationAccess(req, res, req.params.id))) return
    const grants = req.db.prepare(`
      SELECT * FROM grants 
      WHERE organization_id = ? 
      ORDER BY created_at DESC
    `).all(req.params.id);
    
    res.json(grants);
  } catch (error) {
    console.error('Error getting organization grants:', error);
    res.status(500).json(formatError(error));
  }
});

// Get organization's documents
router.get('/:id/documents', ensureAuth, async (req, res) => {
  try {
    if (!(await ensureOrganizationAccess(req, res, req.params.id))) return
    const documents = req.db.prepare(`
      SELECT * FROM documents 
      WHERE organization_id = ? 
      ORDER BY created_at DESC
    `).all(req.params.id);
    
    res.json(documents);
  } catch (error) {
    console.error('Error getting organization documents:', error);
    res.status(500).json(formatError(error));
  }
});

export default router;
