import express from 'express';
import crypto from 'crypto';
import { safeParseJSON } from '../utils/safeJson.js';
import { validatePagination, validateRequiredFields, sanitizeColumns } from '../utils/validation.js';
import { formatError } from '../middleware/errorHandler.js';
import { mutationRateLimiter } from '../middleware/rateLimiting.js';
import { GRANT_STATUSES } from '../config/constants.js';

const router = express.Router();

// Whitelist of allowed columns for UPDATE operations
const ALLOWED_GRANT_COLUMNS = new Set([
  'organization_id', 'funding_opportunity_id', 'title', 'funder', 'deadline',
  'status', 'priority', 'amount_requested', 'amount_awarded', 'application_url',
  'match_score', 'match_reasons', 'notes', 'requirements', 'eligibility',
  'application_steps', 'contact_name', 'contact_email', 'contact_phone'
]);

function ensureGrantAccess(req, res, grantId) {
  const auth = req.user ?? { role: 'guest' }
  if (auth.role === 'guest') {
    res.status(401).json({ error: 'Authentication required' })
    return null
  }

  const grant = req.db.prepare('SELECT * FROM grants WHERE id = ?').get(grantId)
  if (!grant) {
    res.status(404).json({ error: 'Grant not found' })
    return null
  }

  if (auth.role === 'admin') {
    return grant
  }

  if (!auth.profileId) {
    res.status(403).json({ error: 'Not authorized to access this grant' })
    return null
  }

  const profile = req.db
    .prepare('SELECT id FROM profiles WHERE id = ? AND organization_id = ?')
    .get(auth.profileId, grant.organization_id)

  if (!profile) {
    res.status(403).json({ error: 'Not authorized to access this grant' })
    return null
  }

  return grant
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
router.get('/', (req, res) => {
  try {
    const { organization_id, status } = req.query;
    const { limit, offset } = validatePagination(req.query);
    
    let query = `
      SELECT g.*, o.name as organization_name 
      FROM grants g
      LEFT JOIN organizations o ON g.organization_id = o.id
      WHERE 1=1
    `;
    const params = [];
    
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
    
    query += ' ORDER BY g.created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    
    const grants = req.db.prepare(query).all(...params);
    
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
router.get('/pipeline', (req, res) => {
  try {
    const { organization_id } = req.query;
    
    let query = `
      SELECT g.*, o.name as organization_name 
      FROM grants g
      LEFT JOIN organizations o ON g.organization_id = o.id
    `;
    const params = [];
    
    if (organization_id) {
      query += ' WHERE g.organization_id = ?';
      params.push(organization_id);
    }
    
    query += ' ORDER BY g.deadline ASC NULLS LAST, g.created_at DESC';
    
    const grants = req.db.prepare(query).all(...params);
    
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

router.get('/automation/summary', (req, res) => {
  const auth = req.user ?? { role: 'guest' }
  if (auth.role === 'guest') {
    return res.status(401).json({ error: 'Authentication required' })
  }

  const organizationId = req.query.organization_id
  if (!organizationId) {
    return res.status(400).json({ error: 'organization_id query parameter is required' })
  }

  if (auth.role !== 'admin') {
    if (!auth.profileId) {
      return res.status(403).json({ error: 'Not authorized' })
    }
    const profile = req.db
      .prepare('SELECT id FROM profiles WHERE id = ? AND organization_id = ?')
      .get(auth.profileId, organizationId)
    if (!profile) {
      return res.status(403).json({ error: 'Not authorized to access this organization' })
    }
  }

  try {
    const rows = req.db
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

router.get('/:id/automation/events', (req, res) => {
  const grant = ensureGrantAccess(req, res, req.params.id)
  if (!grant) return

  try {
    const limit = Number.parseInt(req.query.limit ?? 25, 10)
    const events = req.db
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

router.get('/:id/automation/latest', (req, res) => {
  const grant = ensureGrantAccess(req, res, req.params.id)
  if (!grant) return

  try {
    const row = req.db
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
router.get('/:id', (req, res) => {
  try {
    const grant = req.db.prepare(`
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
    const milestones = req.db.prepare('SELECT * FROM milestones WHERE grant_id = ? ORDER BY due_date ASC').all(req.params.id);
    const documents = req.db.prepare('SELECT * FROM documents WHERE grant_id = ? ORDER BY created_at DESC').all(req.params.id);
    const expenses = req.db.prepare('SELECT * FROM expenses WHERE grant_id = ? ORDER BY date DESC').all(req.params.id);
    const drafts = req.db.prepare('SELECT * FROM application_drafts WHERE grant_id = ? ORDER BY section_order ASC').all(req.params.id);
    
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
router.post('/', mutationRateLimiter, (req, res) => {
  try {
    const data = req.body;
    
    // Validate required fields
    const validation = validateRequiredFields(data, ['title', 'organization_id']);
    if (!validation.valid) {
      return res.status(400).json({ 
        error: 'Missing required fields', 
        missingFields: validation.missingFields 
      });
    }
    
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
    
    req.db.prepare(`
      INSERT INTO grants (${columns.join(', ')})
      VALUES (${placeholders})
    `).run(...values);
    
    const grant = req.db.prepare('SELECT * FROM grants WHERE id = ?').get(id);
    res.status(201).json(grant);
  } catch (error) {
    console.error('Error creating grant:', error);
    res.status(500).json(formatError(error));
  }
});

// Update grant
router.put('/:id', mutationRateLimiter, (req, res) => {
  try {
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
    
    req.db.prepare(`
      UPDATE grants 
      SET ${setClause}, updated_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `).run(...values);
    
    const grant = req.db.prepare('SELECT * FROM grants WHERE id = ?').get(req.params.id);
    res.json(grant);
  } catch (error) {
    console.error('Error updating grant:', error);
    res.status(500).json(formatError(error));
  }
});

// Update grant status (quick update for drag-and-drop)
router.patch('/:id/status', mutationRateLimiter, (req, res) => {
  try {
    const { status } = req.body;
    
    if (!GRANT_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    
    req.db.prepare(`
      UPDATE grants 
      SET status = ?, updated_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `).run(status, req.params.id);
    
    const grant = req.db.prepare('SELECT * FROM grants WHERE id = ?').get(req.params.id);
    res.json(grant);
  } catch (error) {
    console.error('Error updating grant status:', error);
    res.status(500).json(formatError(error));
  }
});

// Delete grant
router.delete('/:id', mutationRateLimiter, (req, res) => {
  try {
    // Delete related records first
    req.db.prepare('DELETE FROM milestones WHERE grant_id = ?').run(req.params.id);
    req.db.prepare('DELETE FROM expenses WHERE grant_id = ?').run(req.params.id);
    req.db.prepare('DELETE FROM application_drafts WHERE grant_id = ?').run(req.params.id);
    
    // Update documents to remove grant_id
    req.db.prepare('UPDATE documents SET grant_id = NULL WHERE grant_id = ?').run(req.params.id);
    
    // Delete the grant
    req.db.prepare('DELETE FROM grants WHERE id = ?').run(req.params.id);
    
    res.json({ success: true, message: 'Grant deleted' });
  } catch (error) {
    console.error('Error deleting grant:', error);
    res.status(500).json(formatError(error));
  }
});

// Add grant from opportunity (supports both database opportunities and direct data)
router.post('/from-opportunity', (req, res) => {
  try {
    let { 
      opportunity_id, 
      organization_id, 
      profile_id, 
      match_score, 
      match_reasons,
      // Direct opportunity data (for synthetic/discovered opportunities)
      opportunity_data
    } = req.body;
    
    // Try to get opportunity from database first
    let opportunity = null;
    if (opportunity_id) {
      opportunity = req.db.prepare('SELECT * FROM funding_opportunities WHERE id = ?').get(opportunity_id);
    }
    
    // If not found in DB, use provided opportunity_data
    if (!opportunity && opportunity_data) {
      opportunity = {
        title: opportunity_data.title,
        sponsor: opportunity_data.sponsor,
        deadline: opportunity_data.deadline || opportunity_data.deadlineAt,
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
    
    // If no organization_id but profile_id provided, auto-create organization
    if (!organization_id && profile_id) {
      const profile = req.db.prepare('SELECT * FROM profiles WHERE id = ?').get(profile_id);
      if (profile) {
        if (profile.organization_id) {
          // Profile already has an organization
          organization_id = profile.organization_id;
        } else {
          // Create organization for this profile
          const orgId = crypto.randomUUID();
          req.db.prepare(`
            INSERT INTO organizations (id, name, applicant_type, created_at, updated_at)
            VALUES (?, ?, 'individual', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          `).run(orgId, profile.display_name || 'My Organization');
          
          // Link profile to organization
          req.db.prepare('UPDATE profiles SET organization_id = ? WHERE id = ?').run(orgId, profile_id);
          
          organization_id = orgId;
          console.log(`[grants] Auto-created organization ${orgId} for profile ${profile_id}`);
        }
      }
    }
    
    if (!organization_id) {
      return res.status(400).json({ error: 'Organization ID or Profile ID is required' });
    }
    
    // Check for duplicate grants by title for this organization
    const existingGrant = req.db.prepare(
      'SELECT id, title FROM grants WHERE organization_id = ? AND title = ?'
    ).get(organization_id, opportunity.title);
    
    if (existingGrant) {
      return res.status(200).json({ 
        ...existingGrant, 
        organization_id,
        already_exists: true,
        message: 'Grant already in pipeline'
      });
    }
    
    const id = crypto.randomUUID();
    
    req.db.prepare(`
      INSERT INTO grants (
        id, organization_id, funding_opportunity_id, title, funder, 
        deadline, status, match_score, match_reasons, application_url,
        amount_requested, notes
      )
      VALUES (?, ?, ?, ?, ?, ?, 'interested', ?, ?, ?, ?, ?)
    `).run(
      id, 
      organization_id, 
      opportunity_id || null,
      opportunity.title,
      opportunity.sponsor,
      opportunity.deadline,
      match_score || null,
      JSON.stringify(match_reasons || []),
      opportunity.application_url,
      opportunity.amount_max || opportunity.amount_min || null,
      opportunity.description ? opportunity.description.substring(0, 500) : null
    );
    
    const grant = req.db.prepare('SELECT * FROM grants WHERE id = ?').get(id);
    res.status(201).json({ ...grant, organization_id });
  } catch (error) {
    console.error('Error creating grant from opportunity:', error);
    res.status(500).json(formatError(error));
  }
});

export default router;
