import express from 'express';
import crypto from 'crypto';

const router = express.Router();

// List all grants
router.get('/', (req, res) => {
  try {
    const { organization_id, status, limit = 100, offset = 0 } = req.query;
    
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
    params.push(parseInt(limit), parseInt(offset));
    
    const grants = req.db.prepare(query).all(...params);
    
    // Parse JSON fields
    const parsed = grants.map(grant => ({
      ...grant,
      match_reasons: JSON.parse(grant.match_reasons || '[]')
    }));
    
    res.json(parsed);
  } catch (error) {
    console.error('Error listing grants:', error);
    res.status(500).json({ error: error.message });
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
        match_reasons: JSON.parse(grant.match_reasons || '[]')
      };
      
      if (pipeline.hasOwnProperty(grant.status)) {
        pipeline[grant.status].push(parsed);
      }
    });
    
    res.json(pipeline);
  } catch (error) {
    console.error('Error getting pipeline:', error);
    res.status(500).json({ error: error.message });
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
      match_reasons: JSON.parse(grant.match_reasons || '[]')
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
    res.status(500).json({ error: error.message });
  }
});

// Create grant
router.post('/', (req, res) => {
  try {
    const id = crypto.randomUUID();
    const data = req.body;
    
    // Stringify JSON fields
    if (data.match_reasons && Array.isArray(data.match_reasons)) {
      data.match_reasons = JSON.stringify(data.match_reasons);
    }
    
    const columns = ['id', ...Object.keys(data)];
    const placeholders = columns.map(() => '?').join(', ');
    const values = [id, ...Object.values(data)];
    
    req.db.prepare(`
      INSERT INTO grants (${columns.join(', ')})
      VALUES (${placeholders})
    `).run(...values);
    
    const grant = req.db.prepare('SELECT * FROM grants WHERE id = ?').get(id);
    res.status(201).json(grant);
  } catch (error) {
    console.error('Error creating grant:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update grant
router.put('/:id', (req, res) => {
  try {
    const data = req.body;
    
    // Stringify JSON fields
    if (data.match_reasons && Array.isArray(data.match_reasons)) {
      data.match_reasons = JSON.stringify(data.match_reasons);
    }
    
    const setClause = Object.keys(data).map(key => `${key} = ?`).join(', ');
    const values = [...Object.values(data), req.params.id];
    
    req.db.prepare(`
      UPDATE grants 
      SET ${setClause}, updated_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `).run(...values);
    
    const grant = req.db.prepare('SELECT * FROM grants WHERE id = ?').get(req.params.id);
    res.json(grant);
  } catch (error) {
    console.error('Error updating grant:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update grant status (quick update for drag-and-drop)
router.patch('/:id/status', (req, res) => {
  try {
    const { status } = req.body;
    
    const validStatuses = ['discovered', 'interested', 'drafting', 'app_prep', 'revision', 
                          'submitted', 'under_review', 'awarded', 'rejected', 'closed', 'archived'];
    
    if (!validStatuses.includes(status)) {
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
    res.status(500).json({ error: error.message });
  }
});

// Delete grant
router.delete('/:id', (req, res) => {
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
    res.status(500).json({ error: error.message });
  }
});

// Add grant from opportunity
router.post('/from-opportunity', (req, res) => {
  try {
    const { opportunity_id, organization_id, match_score, match_reasons } = req.body;
    
    // Get the opportunity
    const opportunity = req.db.prepare('SELECT * FROM funding_opportunities WHERE id = ?').get(opportunity_id);
    if (!opportunity) {
      return res.status(404).json({ error: 'Opportunity not found' });
    }
    
    const id = crypto.randomUUID();
    
    req.db.prepare(`
      INSERT INTO grants (
        id, organization_id, funding_opportunity_id, title, funder, 
        deadline, status, match_score, match_reasons, application_url
      )
      VALUES (?, ?, ?, ?, ?, ?, 'interested', ?, ?, ?)
    `).run(
      id, 
      organization_id, 
      opportunity_id, 
      opportunity.title,
      opportunity.sponsor,
      opportunity.deadline,
      match_score || null,
      JSON.stringify(match_reasons || []),
      opportunity.application_url
    );
    
    const grant = req.db.prepare('SELECT * FROM grants WHERE id = ?').get(id);
    res.status(201).json(grant);
  } catch (error) {
    console.error('Error creating grant from opportunity:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
