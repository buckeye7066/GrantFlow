import express from 'express';
import crypto from 'crypto';
import { safeParseJSON } from '../utils/safeJson.js';
import { validatePagination, validateRequiredFields, sanitizeColumns } from '../utils/validation.js';
import { formatError } from '../middleware/errorHandler.js';
import { ensureAuth } from '../middleware/auth.js';
import { mutationRateLimiter } from '../middleware/rateLimiting.js';

const router = express.Router();

// Whitelist of allowed columns for UPDATE operations
const ALLOWED_ORGANIZATION_COLUMNS = new Set([
  'name', 'email', 'phone', 'city', 'state', 'zip', 'address',
  'applicant_type', 'mission', 'funding_amount_needed', 'website',
  'keywords', 'focus_areas', 'program_areas', 'government_assistance',
  'disabilities', 'target_colleges', 'federal_registrations', 'financial_challenges',
  'veteran', 'disabled', 'first_generation', 'snap_recipient', 'ssi_recipient', 'tanf_recipient'
]);

// List all organizations
router.get('/', ensureAuth, async (req, res) => {
  try {
    const { search, state, type } = req.query;
    const { limit, offset } = validatePagination(req.query);
    
    let query = 'SELECT * FROM organizations WHERE 1=1';
    const params = [];
    
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
    
    const orgs = await req.db.prepare(query).all(...params);
    
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
    
    res.json(parsed);
  } catch (error) {
    console.error('Error listing organizations:', error);
    res.status(500).json(formatError(error));
  }
});

// Get single organization
router.get('/:id', ensureAuth, async (req, res) => {
  try {
    const org = await req.db.prepare('SELECT * FROM organizations WHERE id = ?').get(req.params.id);
    
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
    
    res.json(parsed);
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
    
    await req.db.prepare(`
      INSERT INTO organizations (${columns.join(', ')})
      VALUES (${placeholders})
    `).run(...values);
    
    const org = await req.db.prepare('SELECT * FROM organizations WHERE id = ?').get(id);
    res.status(201).json(org);
  } catch (error) {
    console.error('Error creating organization:', error);
    res.status(500).json(formatError(error));
  }
});

// Update organization
router.put('/:id', ensureAuth, mutationRateLimiter, async (req, res) => {
  try {
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
    
    await req.db.prepare(`
      UPDATE organizations 
      SET ${setClause}, updated_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `).run(...values);
    
    const org = await req.db.prepare('SELECT * FROM organizations WHERE id = ?').get(req.params.id);
    res.json(org);
  } catch (error) {
    console.error('Error updating organization:', error);
    res.status(500).json(formatError(error));
  }
});

// Delete organization (soft delete with deleted_at timestamp)
router.delete('/:id', ensureAuth, mutationRateLimiter, async (req, res) => {
  try {
    // Check if organization exists
    const org = await req.db.prepare('SELECT id FROM organizations WHERE id = ?').get(req.params.id);
    if (!org) {
      return res.status(404).json({ error: 'Organization not found' });
    }
    
    // Soft delete by setting deleted_at (schema-managed; do not attempt runtime ALTER in Postgres)
    await req.db.prepare('UPDATE organizations SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
    
    res.json({ success: true, message: 'Organization marked as deleted' });
  } catch (error) {
    console.error('Error deleting organization:', error);
    res.status(500).json(formatError(error));
  }
});

// Get organization's grants
router.get('/:id/grants', ensureAuth, async (req, res) => {
  try {
    const grants = await req.db.prepare(`
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
    const documents = await req.db.prepare(`
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
