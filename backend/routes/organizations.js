import express from 'express';
import crypto from 'crypto';
import { safeParseJSON } from '../utils/safeJson.js';
import { validatePagination, validateRequiredFields, sanitizeColumns } from '../utils/validation.js';
import { formatError } from '../middleware/errorHandler.js';
import { ensureAuth } from '../middleware/auth.js';
import { mutationRateLimiter } from '../middleware/rateLimiting.js';
import {
  normalizeEmailField,
  normalizePhoneField,
  parseOrganizationRow,
  syncOrganizationToProfileSections,
} from '../services/profileOrganizationSync.js'
import { getAccessibleOrganizationIds, ensureOrganizationAccess, requireAuthenticatedUser } from '../utils/accessControl.js'

import { createLogger } from '../utils/logger.js'
const routeLogger = createLogger('route:organizations')

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

/** GET / query ?sort=&order= — must be SQL identifiers only (whitelist). */
const ORG_LIST_SORTABLE = new Set([
  'name', 'created_at', 'updated_at', 'email', 'state', 'city', 'zip', 'applicant_type',
])

function resolveOrgListSort(query) {
  const raw = String(query?.sort || 'created_at').trim()
  const sortCol = ORG_LIST_SORTABLE.has(raw) ? raw : 'created_at'
  const orderRaw = String(query?.order || 'desc').toLowerCase()
  const orderDir = orderRaw === 'asc' ? 'ASC' : 'DESC'
  return { sortCol, orderDir }
}

// List all organizations
router.get('/', ensureAuth, async (req, res) => {
  try {
    const user = requireAuthenticatedUser(req, res)
    if (!user) return

    const { search, state, type } = req.query;
    const { limit, offset } = validatePagination(req.query);
    const { sortCol, orderDir } = resolveOrgListSort(req.query)

    let query = 'SELECT * FROM organizations WHERE deleted_at IS NULL';
    const params = [];

    // Access control: non-admins can only see organizations linked to their profiles.
    if (req.ctx?.isAdmin !== true) {
      const orgIds = await getAccessibleOrganizationIds(req.db, user)
      if (!orgIds || orgIds.size === 0) {
        routeLogger.info('[organizations] GET / - user %s has no accessible org IDs; returning empty list', user?.id ?? 'unknown')
        return res.json([])
      }
      const placeholders = Array.from(orgIds).map(() => '?').join(', ')
      query += ` AND id IN (${placeholders})`
      params.push(...Array.from(orgIds))
    }
    
    if (search) {
      const op = req.db?.dialect === 'postgres' ? 'ILIKE' : 'LIKE'
      query += ` AND (name ${op} ? OR email ${op} ? OR city ${op} ?)`;
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
    
    query += ` ORDER BY ${sortCol} ${orderDir} LIMIT ? OFFSET ?`;
    params.push(limit, offset);
    
    let orgs;
    try {
      orgs = await req.db.prepare(query).all(...params);
    } catch (error) {
      console.error('Database query failed:', error);
      throw error;
    }
    
    const rows = Array.isArray(orgs) ? orgs : []
    const parsed = rows.map((org) => parseOrganizationRow(org)).filter(Boolean)

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
  const profileRow = await db
    .prepare(
      `SELECT id FROM profiles WHERE organization_id = ? ORDER BY created_at ASC LIMIT 1`
    )
    .get(orgId)
  if (!profileRow?.id) return base

  const sectionRows = await db
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

  const mergeValue = (a, b) => ((b !== null && b !== undefined) && b !== '' && (Array.isArray(b) ? b.length > 0 : true) ? b : a)

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
    const org = await req.db.prepare('SELECT * FROM organizations WHERE id = ?').get(req.params.id);
    
    if (!org) {
      return res.status(404).json({ error: 'Organization not found' });
    }
    
    const parsed = parseOrganizationRow(org)

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
    
    // audit:allow unscoped-profile-query -- organizations do not carry profile_id; access is enforced by ensureAuth/creation ownership.
    await req.db.prepare(`
      INSERT INTO organizations (${columns.join(', ')})
      VALUES (${placeholders})
    `).run(...values);
    
    const org = await req.db.prepare('SELECT * FROM organizations WHERE id = ?').get(id);

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
    
    // audit:allow unscoped-profile-query -- organizations do not carry profile_id; access is enforced by ensureOrganizationAccess above.
    await req.db.prepare(`
      UPDATE organizations 
      SET ${setClause}, updated_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `).run(...values);
    
    const org = await req.db.prepare('SELECT * FROM organizations WHERE id = ?').get(req.params.id);

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
    const org = await req.db.prepare('SELECT id FROM organizations WHERE id = ?').get(req.params.id);
    if (!org) {
      return res.status(404).json({ error: 'Organization not found' });
    }
    
    // Soft delete by setting deleted_at (schema-managed; do not attempt runtime ALTER in Postgres)
    await req.db.prepare('UPDATE organizations SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);

    // Propagate soft-delete to linked profile so the matcher and Anya skip it
    await req.db
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
    // audit:allow unscoped-profile-query -- organization access is enforced above; grant rows remain tied to the authorized organization.
    const grants = await req.db.prepare(`
      SELECT g.* FROM grants g
      JOIN organizations o ON o.id = g.organization_id
      WHERE g.organization_id = ?
        AND o.deleted_at IS NULL
      ORDER BY g.created_at DESC
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
    // audit:allow unscoped-profile-query -- organization access is enforced above; document rows remain tied to the authorized organization.
    const documents = await req.db.prepare(`
      SELECT d.* FROM documents d
      JOIN organizations o ON o.id = d.organization_id
      WHERE d.organization_id = ?
        AND o.deleted_at IS NULL
      ORDER BY d.created_at DESC
    `).all(req.params.id);
    
    res.json(documents);
  } catch (error) {
    console.error('Error getting organization documents:', error);
    res.status(500).json(formatError(error));
  }
});

export default router;
