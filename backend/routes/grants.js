import express from 'express';
import crypto from 'crypto';
import { safeParseJSON } from '../utils/safeJson.js';
import { validatePagination, validateRequiredFields, sanitizeColumns } from '../utils/validation.js';
import { formatError } from '../middleware/errorHandler.js';
import { mutationRateLimiter } from '../middleware/rateLimiting.js';
import { GRANT_STATUSES } from '../config/constants.js';
import {
  ensureGrantAccess as ensureGrantAccessUtil,
  ensureOrganizationAccess,
  ensureProfileAccess,
  getAccessibleOrganizationIds,
  isAdminUser,
  requireAuthenticatedUser,
} from '../utils/accessControl.js'
import { scheduleGrantApplicationApproach } from '../services/grantApplicationApproachAdvisor.js'

const router = express.Router();

// Whitelist of allowed columns for UPDATE operations
const ALLOWED_GRANT_COLUMNS = new Set([
  'organization_id', 'funding_opportunity_id', 'title', 'funder', 'deadline',
  'status', 'priority', 'amount_requested', 'amount_awarded', 'application_url',
  'match_score', 'match_reasons', 'notes', 'requirements', 'eligibility',
  'application_steps', 'contact_name', 'contact_email', 'contact_phone'
]);

// NOTE: Access control is centralized in `backend/utils/accessControl.js`

let postgresHasGrantsProfileIdColumn = null
let sqliteHasGrantsProfileIdColumn = null

async function hasColumn(db, { tableName, columnName }) {
  const dialect = db?.dialect || 'sqlite'
  if (dialect === 'postgres') {
    const row = await db
      .prepare(
        `
          SELECT 1 AS ok
          FROM information_schema.columns
          WHERE table_schema='public'
            AND table_name=?
            AND column_name=?
          LIMIT 1
        `,
      )
      .get(String(tableName), String(columnName))
    return Boolean(row?.ok)
  }

  // SQLite
  const rows = await db.prepare(`PRAGMA table_info(${String(tableName)})`).all()
  return rows.some((r) => String(r?.name || '').toLowerCase() === String(columnName).toLowerCase())
}

async function grantsHasProfileIdColumn(db) {
  const dialect = db?.dialect || 'sqlite'
  if (dialect === 'postgres') {
    if (postgresHasGrantsProfileIdColumn === null) {
      postgresHasGrantsProfileIdColumn = await hasColumn(db, { tableName: 'grants', columnName: 'profile_id' })
    }
    return postgresHasGrantsProfileIdColumn
  }

  if (sqliteHasGrantsProfileIdColumn === null) {
    sqliteHasGrantsProfileIdColumn = await hasColumn(db, { tableName: 'grants', columnName: 'profile_id' })
  }
  return sqliteHasGrantsProfileIdColumn
}

function normalizeSortColumn(raw) {
  const key = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (!key) return 'g.created_at'

  // Back-compat for older UI sort keys.
  const normalizedKey =
    key === 'created_date' ? 'created_at' :
    key === 'updated_date' ? 'updated_at' :
    key

  // Only allow known columns (prevent SQL injection via sort param).
  const allowed = new Set([
    'created_at',
    'updated_at',
    'deadline',
    'status',
    'priority',
    'title',
    'funder',
    'amount_requested',
    'amount_awarded',
    'match_score',
  ])

  if (!allowed.has(normalizedKey)) return 'g.created_at'
  return `g.${normalizedKey}`
}

function normalizeSortOrder(raw) {
  const key = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  return key === 'asc' ? 'ASC' : 'DESC'
}

function mapAutomationEvent(row) {
  if (!row) return null
  const actions = safeParseJSON(row.recommended_actions, []);

  return {
    id: row.id,
    created_at: row.created_at,
    grant_id: row.grant_id,
    job_id: row.job_id,
    previous_status: row.previous_status,
    suggested_status: row.suggested_status,
    applied_status: row.applied_status,
    confidence: row.confidence,
    handoff_required: Boolean(row.handoff_required),
    handoff_reason: row.handoff_reason,
    recommended_actions: actions,
    ai_summary: row.ai_summary,
  }
}

// List all grants
router.get('/', async (req, res) => {
  try {
    const user = requireAuthenticatedUser(req, res)
    if (!user) return

    const { organization_id, status } = req.query;
    const sortCol = normalizeSortColumn(req.query.sort)
    const sortOrder = normalizeSortOrder(req.query.order)
    const headerProfileId = typeof req.headers['x-profile-id'] === 'string' ? req.headers['x-profile-id'] : null
    const profile_id = (typeof req.query.profile_id === 'string' ? req.query.profile_id : null) || headerProfileId
    const { limit, offset } = validatePagination(req.query);
    
    let query = `
      SELECT g.*, o.name as organization_name 
      FROM grants g
      LEFT JOIN organizations o ON g.organization_id = o.id
      WHERE 1=1
    `;
    const params = [];

    if (!isAdminUser(user)) {
      // If an active profile is selected, list the profile-scoped pipeline.
      if (profile_id) {
        if (!(await ensureProfileAccess(req, res, String(profile_id)))) return
        query += ` AND g.profile_id = ?`
        params.push(String(profile_id))
      } else {
        // Backward compatible: fall back to organization-scoped listing.
        // Also include any profile-scoped grants the user can access (in case org_id is null).
        const ctxProfiles = req.ctx?.accessibleProfileIds instanceof Set ? Array.from(req.ctx.accessibleProfileIds) : []
        const orgIds = await getAccessibleOrganizationIds(req.db, user)
        const ctxOrgs = orgIds instanceof Set ? Array.from(orgIds) : []

        if (ctxProfiles.length === 0 && ctxOrgs.length === 0) {
          return res.json([])
        }

        const clauses = []
        if (ctxProfiles.length > 0) {
          clauses.push(`g.profile_id IN (${ctxProfiles.map(() => '?').join(',')})`)
          params.push(...ctxProfiles)
        }
        if (ctxOrgs.length > 0) {
          clauses.push(`g.organization_id IN (${ctxOrgs.map(() => '?').join(',')})`)
          params.push(...ctxOrgs)
        }
        query += ` AND (${clauses.join(' OR ')})`
      }

      if (organization_id) {
        // If organization_id filter is requested, require explicit access.
        const orgIds = await getAccessibleOrganizationIds(req.db, user)
        if (organization_id && (!orgIds || !orgIds.has(String(organization_id)))) {
          return res.status(403).json({ error: 'Not authorized to access this organization' })
        }
      }
    } else {
      if (profile_id) {
        query += ` AND g.profile_id = ?`
        params.push(String(profile_id))
      }
    }
    
    if (organization_id) {
      query += ' AND g.organization_id = ?';
      params.push(organization_id);
    }
    
    if (status) {
      if (status.includes(',')) {
        const statuses = status.split(',');
        query += ` AND g.status IN (${statuses.map(() => '?').join(',')})`;
        params.push(...statuses);
      } else {
        query += ' AND g.status = ?';
        params.push(status);
      }
    }
    
    query += ` ORDER BY ${sortCol} ${sortOrder} LIMIT ? OFFSET ?`;
    params.push(limit, offset);
    
    const grants = await req.db.prepare(query).all(...params);
    
    // Parse JSON fields safely
    const parsed = grants.map(grant => ({
      ...grant,
      match_reasons: safeParseJSON(grant.match_reasons, [])
    }));
    
    res.json(parsed);
  } catch (error) {
    console.error('Error listing grants:', error);
    res.status(500).json(formatError(error));
  }
});

// Get grants grouped by status (for pipeline view)
router.get('/pipeline', async (req, res) => {
  try {
    const user = requireAuthenticatedUser(req, res)
    if (!user) return

    const { organization_id } = req.query;
    
    let query = `
      SELECT g.*, o.name as organization_name 
      FROM grants g
      LEFT JOIN organizations o ON g.organization_id = o.id
    `;
    const params = [];

    if (!isAdminUser(user)) {
      const orgIds = await getAccessibleOrganizationIds(req.db, user)
      if (!orgIds || orgIds.size === 0) {
        return res.json({
          discovered: [],
          interested: [],
          drafting: [],
          app_prep: [],
          revision: [],
          submitted: [],
          awarded: [],
          rejected: [],
        })
      }
      if (organization_id && !orgIds.has(String(organization_id))) {
        return res.status(403).json({ error: 'Not authorized to access this organization' })
      }
      const placeholders = Array.from(orgIds).map(() => '?').join(',')
      query += ` WHERE g.organization_id IN (${placeholders})`
      params.push(...Array.from(orgIds))
    }
    
    if (organization_id) {
      query += isAdminUser(user) ? ' WHERE g.organization_id = ?' : ' AND g.organization_id = ?';
      params.push(organization_id);
    }
    
    query += ' ORDER BY g.deadline ASC NULLS LAST, g.created_at DESC';
    
    const grants = await req.db.prepare(query).all(...params);
    
    // Group by status
    const pipeline = {
      discovered: [],
      interested: [],
      drafting: [],
      app_prep: [],
      revision: [],
      submitted: [],
      awarded: [],
      rejected: []
    };
    
    grants.forEach(grant => {
      const parsed = {
        ...grant,
        match_reasons: safeParseJSON(grant.match_reasons, [])
      };
      
      if (pipeline.hasOwnProperty(grant.status)) {
        pipeline[grant.status].push(parsed);
      }
    });
    
    res.json(pipeline);
  } catch (error) {
    console.error('Error getting pipeline:', error);
    res.status(500).json(formatError(error));
  }
});

router.get('/automation/summary', async (req, res) => {
  const auth = requireAuthenticatedUser(req, res)
  if (!auth) return

  const organizationId = req.query.organization_id
  if (!organizationId) {
    return res.status(400).json({ error: 'organization_id query parameter is required' })
  }

  if (!isAdminUser(auth)) {
    if (!(await ensureOrganizationAccess(req, res, String(organizationId)))) return
  }

  try {
    const rows = await req.db
      .prepare(
        `
          WITH latest AS (
            SELECT grant_id, MAX(created_at) AS created_at
            FROM grant_pipeline_events
            GROUP BY grant_id
          )
          SELECT
            g.id,
            g.title,
            g.status,
            g.deadline,
            g.priority,
            e.created_at AS automation_at,
            e.applied_status AS automation_status,
            e.handoff_required,
            e.handoff_reason,
            e.ai_summary
          FROM grants g
          LEFT JOIN latest l ON l.grant_id = g.id
          LEFT JOIN grant_pipeline_events e
            ON e.grant_id = l.grant_id AND e.created_at = l.created_at
          WHERE g.organization_id = ?
          ORDER BY g.status ASC, g.updated_at DESC
        `,
      )
      .all(organizationId)

    res.json(
      rows.map((row) => ({
        id: row.id,
        title: row.title,
        status: row.status,
        deadline: row.deadline,
        priority: row.priority,
        automation: row.automation_at
          ? {
              processed_at: row.automation_at,
              status: row.automation_status,
              handoff_required: Boolean(row.handoff_required),
              handoff_reason: row.handoff_reason,
              summary: row.ai_summary,
            }
          : null,
      })),
    )
  } catch (error) {
    console.error('Error building automation summary:', error)
    res.status(500).json(formatError(error))
  }
});

router.get('/:id/automation/events', async (req, res) => {
  const grant = await ensureGrantAccessUtil(req, res, req.params.id)
  if (!grant) return

  try {
    const limit = Number.parseInt(req.query.limit ?? 25, 10)
    const events = await req.db
      .prepare(
        `
          SELECT *
          FROM grant_pipeline_events
          WHERE grant_id = ?
          ORDER BY created_at DESC
          LIMIT ?
        `,
      )
      .all(grant.id, Number.isFinite(limit) ? limit : 25)

    res.json(events.map(mapAutomationEvent))
  } catch (error) {
    console.error('Error listing automation events:', error)
    res.status(500).json(formatError(error))
  }
});

router.get('/:id/automation/latest', async (req, res) => {
  const grant = await ensureGrantAccessUtil(req, res, req.params.id)
  if (!grant) return

  try {
    const row = await req.db
      .prepare(
        `
          SELECT *
          FROM grant_pipeline_events
          WHERE grant_id = ?
          ORDER BY created_at DESC
          LIMIT 1
        `,
      )
      .get(grant.id)

    res.json(mapAutomationEvent(row))
  } catch (error) {
    console.error('Error fetching latest automation event:', error)
    res.status(500).json(formatError(error))
  }
});

// Get single grant
router.get('/:id', async (req, res) => {
  try {
    const grantAccess = await ensureGrantAccessUtil(req, res, req.params.id)
    if (!grantAccess) return

    const grant = await req.db.prepare(`
      SELECT g.*, o.name as organization_name 
      FROM grants g
      LEFT JOIN organizations o ON g.organization_id = o.id
      WHERE g.id = ?
    `).get(req.params.id);
    
    if (!grant) {
      return res.status(404).json({ error: 'Grant not found' });
    }
    
    // Parse JSON fields
    const parsed = {
      ...grant,
      match_reasons: safeParseJSON(grant.match_reasons, [])
    };
    
    // Get related data
    const milestones = await req.db.prepare('SELECT * FROM milestones WHERE grant_id = ? ORDER BY due_date ASC').all(req.params.id);
    const documents = await req.db.prepare('SELECT * FROM documents WHERE grant_id = ? ORDER BY created_at DESC').all(req.params.id);
    const expenses = await req.db.prepare('SELECT * FROM expenses WHERE grant_id = ? ORDER BY date DESC').all(req.params.id);
    const drafts = await req.db.prepare('SELECT * FROM application_drafts WHERE grant_id = ? ORDER BY section_order ASC').all(req.params.id);
    
    res.json({
      ...parsed,
      milestones,
      documents,
      expenses,
      application_drafts: drafts
    });
  } catch (error) {
    console.error('Error getting grant:', error);
    res.status(500).json(formatError(error));
  }
});

// Create grant
router.post('/', mutationRateLimiter, async (req, res) => {
  try {
    const user = requireAuthenticatedUser(req, res)
    if (!user) return

    const data = req.body;
    
    // Validate required fields
    const validation = validateRequiredFields(data, ['title', 'organization_id']);
    if (!validation.valid) {
      return res.status(400).json({ 
        error: 'Missing required fields', 
        missingFields: validation.missingFields 
      });
    }
    
    if (!(await ensureOrganizationAccess(req, res, String(data.organization_id)))) return

    const id = crypto.randomUUID();
    
    // Sanitize columns against whitelist
    const sanitizedData = sanitizeColumns(data, ALLOWED_GRANT_COLUMNS);
    
    // Stringify JSON fields
    if (sanitizedData.match_reasons && Array.isArray(sanitizedData.match_reasons)) {
      sanitizedData.match_reasons = JSON.stringify(sanitizedData.match_reasons);
    }
    
    const columns = ['id', ...Object.keys(sanitizedData)];
    const placeholders = columns.map(() => '?').join(', ');
    const values = [id, ...Object.values(sanitizedData)];
    
    await req.db.prepare(`
      INSERT INTO grants (${columns.join(', ')})
      VALUES (${placeholders})
    `).run(...values);
    
    const grant = await req.db.prepare('SELECT * FROM grants WHERE id = ?').get(id);
    res.status(201).json(grant);
  } catch (error) {
    console.error('Error creating grant:', error);
    res.status(500).json(formatError(error));
  }
});

// Update grant
router.put('/:id', mutationRateLimiter, async (req, res) => {
  try {
    const grantAccess = await ensureGrantAccessUtil(req, res, req.params.id)
    if (!grantAccess) return

    const data = req.body;
    
    // Sanitize columns against whitelist
    const sanitizedData = sanitizeColumns(data, ALLOWED_GRANT_COLUMNS);
    
    if (Object.keys(sanitizedData).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }
    
    // Stringify JSON fields
    if (sanitizedData.match_reasons && Array.isArray(sanitizedData.match_reasons)) {
      sanitizedData.match_reasons = JSON.stringify(sanitizedData.match_reasons);
    }
    
    const setClause = Object.keys(sanitizedData).map(key => `${key} = ?`).join(', ');
    const values = [...Object.values(sanitizedData), req.params.id];
    
    await req.db.prepare(`
      UPDATE grants 
      SET ${setClause}, updated_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `).run(...values);
    
    const grant = await req.db.prepare('SELECT * FROM grants WHERE id = ?').get(req.params.id);
    res.json(grant);
  } catch (error) {
    console.error('Error updating grant:', error);
    res.status(500).json(formatError(error));
  }
});

// Update grant status (quick update for drag-and-drop)
router.patch('/:id/status', mutationRateLimiter, async (req, res) => {
  try {
    const grantAccess = await ensureGrantAccessUtil(req, res, req.params.id)
    if (!grantAccess) return

    const { status } = req.body;
    
    if (!GRANT_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    
    await req.db.prepare(`
      UPDATE grants 
      SET status = ?, updated_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `).run(status, req.params.id);
    
    const grant = await req.db.prepare('SELECT * FROM grants WHERE id = ?').get(req.params.id);
    res.json(grant);
  } catch (error) {
    console.error('Error updating grant status:', error);
    res.status(500).json(formatError(error));
  }
});

// Delete grant
router.delete('/:id', mutationRateLimiter, async (req, res) => {
  try {
    const grantAccess = await ensureGrantAccessUtil(req, res, req.params.id)
    if (!grantAccess) return

    // Delete related records first
    await req.db.prepare('DELETE FROM milestones WHERE grant_id = ?').run(req.params.id);
    await req.db.prepare('DELETE FROM expenses WHERE grant_id = ?').run(req.params.id);
    await req.db.prepare('DELETE FROM application_drafts WHERE grant_id = ?').run(req.params.id);
    
    // Update documents to remove grant_id
    await req.db.prepare('UPDATE documents SET grant_id = NULL WHERE grant_id = ?').run(req.params.id);
    
    // Delete the grant
    await req.db.prepare('DELETE FROM grants WHERE id = ?').run(req.params.id);
    
    res.json({ success: true, message: 'Grant deleted' });
  } catch (error) {
    console.error('Error deleting grant:', error);
    res.status(500).json(formatError(error));
  }
});

// Add grant from opportunity (supports both database opportunities and direct data)
router.post('/from-opportunity', async (req, res) => {
  try {
    const user = requireAuthenticatedUser(req, res)
    if (!user) return

    let {
      opportunity_id, 
      organization_id, 
      profile_id, 
      match_score, 
      match_reasons,
      // Direct opportunity data (for synthetic/discovered opportunities)
      opportunity_data
    } = req.body;

    const normalizedProfileId = profile_id ? String(profile_id) : null
    const normalizedOrgId = organization_id ? String(organization_id) : null

    if (!normalizedProfileId && !normalizedOrgId) {
      return res.status(400).json({
        error: 'Profile ID or Organization ID is required',
        message: 'Provide profile_id (preferred) or organization_id to add a grant to the pipeline.',
      })
    }

    // Authorization:
    // - If profile_id provided, profile access is the source of truth (org may be auto-created/linked).
    // - If only organization_id provided, require org access.
    if (normalizedProfileId) {
      if (!(await ensureProfileAccess(req, res, normalizedProfileId))) return
    } else if (normalizedOrgId) {
      if (!(await ensureOrganizationAccess(req, res, normalizedOrgId))) return
    }
    
    // Try to get opportunity from database first
    let opportunity = null;
    if (opportunity_id) {
      opportunity = await req.db.prepare('SELECT * FROM funding_opportunities WHERE id = ?').get(opportunity_id);
    }
    
    // If not found in DB, use provided opportunity_data
    if (!opportunity && opportunity_data) {
      // Postgres safety: `grants.deadline` is a DATE; empty strings (and some ISO timestamps)
      // will hard-fail inserts. Normalize to YYYY-MM-DD or NULL.
      let normalizedDeadline = opportunity_data.deadline || opportunity_data.deadlineAt || null
      if (typeof normalizedDeadline === 'string') {
        const s = normalizedDeadline.trim()
        if (!s) normalizedDeadline = null
        else if (/^\d{4}-\d{2}-\d{2}T/.test(s)) normalizedDeadline = s.slice(0, 10)
      }

      opportunity = {
        title: opportunity_data.title,
        sponsor: opportunity_data.sponsor,
        deadline: normalizedDeadline,
        application_url: opportunity_data.url || opportunity_data.application_url,
        amount_min: opportunity_data.awardMin || opportunity_data.amount_min,
        amount_max: opportunity_data.awardMax || opportunity_data.amount_max,
        description: opportunity_data.descriptionMd || opportunity_data.description,
        eligibility_bullets: JSON.stringify(opportunity_data.eligibilityBullets || []),
        source: opportunity_data.source || 'discovery'
      };
      console.log('[grants] Using direct opportunity data for:', opportunity.title);
    }
    
    if (!opportunity) {
      return res.status(404).json({ error: 'Opportunity not found and no opportunity_data provided' });
    }
    
    // TRANSACTION: Wrap multi-step grant pipeline creation
    const result = await req.db.withTransaction(async (tx) => {
      const hasProfileId = await grantsHasProfileIdColumn(tx)

      // If no organization_id but profile_id provided, auto-create organization
      let finalOrgId = normalizedOrgId
      let finalProfileId = normalizedProfileId

      if (!finalOrgId && finalProfileId) {
        const profile = await tx.prepare('SELECT * FROM profiles WHERE id = ?').get(finalProfileId);
        if (profile) {
          if (profile.organization_id) {
            // Profile already has an organization
            finalOrgId = profile.organization_id;
          } else {
            // Create organization for this profile
            const orgId = crypto.randomUUID();
            await tx.prepare(`
              INSERT INTO organizations (id, name, applicant_type, created_at, updated_at)
              VALUES (?, ?, 'individual', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            `).run(orgId, profile.display_name || 'My Organization');
            
            // Link profile to organization
            await tx.prepare('UPDATE profiles SET organization_id = ? WHERE id = ?').run(orgId, finalProfileId);
            
            finalOrgId = orgId;
            console.log(`[grants] Auto-created organization ${orgId} for profile ${finalProfileId}`);
          }
        }
      }
      
      if (!finalOrgId) {
        throw new Error('Organization ID or Profile ID is required');
      }

      // If a caller provided organization_id explicitly, enforce org access even when profile_id is present.
      // Otherwise profile access is sufficient (especially for legacy profiles without user_id mappings).
      if (normalizedOrgId) {
        const accessReq = { user: req.user, ctx: req.ctx, db: tx }
        if (!(await ensureOrganizationAccess(accessReq, res, String(finalOrgId)))) {
          // Ensure we don't throw later on a null result.
          return { _aborted: true }
        }
      }
      
      // Check for duplicate grants by title for this organization
      const existingGrant = hasProfileId && finalProfileId
        ? await tx
            .prepare(
              `
                SELECT id, title
                FROM grants
                WHERE profile_id = ?
                  AND (
                    (? IS NOT NULL AND funding_opportunity_id = ?)
                    OR (funding_opportunity_id IS NULL AND title = ?)
                  )
                LIMIT 1
              `,
            )
            .get(String(finalProfileId), opportunity_id ?? null, opportunity_id ?? null, opportunity.title)
        : await tx
            .prepare(
              `
                SELECT id, title
                FROM grants
                WHERE organization_id = ?
                  AND (
                    (? IS NOT NULL AND funding_opportunity_id = ?)
                    OR (funding_opportunity_id IS NULL AND title = ?)
                  )
                LIMIT 1
              `,
            )
            .get(String(finalOrgId), opportunity_id ?? null, opportunity_id ?? null, opportunity.title);
      
      if (existingGrant) {
        return { 
          ...existingGrant, 
          organization_id: finalOrgId,
          already_exists: true,
          message: 'Grant already in pipeline'
        };
      }
      
      const id = crypto.randomUUID();

      // Postgres safety: reject empty deadline strings
      let insertDeadline = opportunity.deadline ?? null
      if (typeof insertDeadline === 'string') {
        const s = insertDeadline.trim()
        if (!s) insertDeadline = null
        else if (/^\d{4}-\d{2}-\d{2}T/.test(s)) insertDeadline = s.slice(0, 10)
      }
      
      if (hasProfileId) {
        await tx.prepare(`
          INSERT INTO grants (
            id, organization_id, profile_id, funding_opportunity_id, title, funder, 
            deadline, status, match_score, match_reasons, application_url,
            amount_requested, notes
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, 'interested', ?, ?, ?, ?, ?)
        `).run(
          id, 
          finalOrgId,
          finalProfileId ? String(finalProfileId) : null,
          opportunity_id || null,
          opportunity.title,
          opportunity.sponsor,
          insertDeadline,
          match_score || null,
          JSON.stringify(match_reasons || []),
          opportunity.application_url,
          opportunity.amount_max || opportunity.amount_min || null,
          opportunity.description ? opportunity.description.substring(0, 500) : null
        );
      } else {
        await tx.prepare(`
          INSERT INTO grants (
            id, organization_id, funding_opportunity_id, title, funder, 
            deadline, status, match_score, match_reasons, application_url,
            amount_requested, notes
          )
          VALUES (?, ?, ?, ?, ?, ?, 'interested', ?, ?, ?, ?, ?)
        `).run(
          id, 
          finalOrgId,
          opportunity_id || null,
          opportunity.title,
          opportunity.sponsor,
          insertDeadline,
          match_score || null,
          JSON.stringify(match_reasons || []),
          opportunity.application_url,
          opportunity.amount_max || opportunity.amount_min || null,
          opportunity.description ? opportunity.description.substring(0, 500) : null
        );
      }
      
      const grant = await tx.prepare('SELECT * FROM grants WHERE id = ?').get(id);
      return { ...grant, organization_id: finalOrgId };
    });

    if (result && result._aborted) return
    
    // If grant already exists, return 200, otherwise 201
    const statusCode = result.already_exists ? 200 : 201;
    // Trigger non-blocking application approach advisor for newly created grants.
    if (!result.already_exists && result?.id) {
      scheduleGrantApplicationApproach({ db: req.db, grantId: result.id })
    }
    res.status(statusCode).json(result);
  } catch (error) {
    console.error('Error creating grant from opportunity:', error);
    res.status(500).json(formatError(error));
  }
});

export default router;
