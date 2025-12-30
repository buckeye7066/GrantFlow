import express from 'express';
import crypto from 'crypto';

const router = express.Router();

// List all organizations
router.get('/', (req, res) => {
  try {
    const { search, state, type, limit = 100, offset = 0 } = req.query;
    
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
    params.push(parseInt(limit), parseInt(offset));
    
    const orgs = req.db.prepare(query).all(...params);
    
    // Parse JSON fields
    const parsed = orgs.map(org => ({
      ...org,
      keywords: JSON.parse(org.keywords || '[]'),
      focus_areas: JSON.parse(org.focus_areas || '[]'),
      program_areas: JSON.parse(org.program_areas || '[]'),
      government_assistance: JSON.parse(org.government_assistance || '[]'),
      disabilities: JSON.parse(org.disabilities || '[]'),
      target_colleges: JSON.parse(org.target_colleges || '[]'),
      federal_registrations: JSON.parse(org.federal_registrations || '[]'),
      financial_challenges: JSON.parse(org.financial_challenges || '[]')
    }));
    
    res.json(parsed);
  } catch (error) {
    console.error('Error listing organizations:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get single organization
router.get('/:id', (req, res) => {
  try {
    const org = req.db.prepare('SELECT * FROM organizations WHERE id = ?').get(req.params.id);
    
    if (!org) {
      return res.status(404).json({ error: 'Organization not found' });
    }
    
    // Parse JSON fields
    const parsed = {
      ...org,
      keywords: JSON.parse(org.keywords || '[]'),
      focus_areas: JSON.parse(org.focus_areas || '[]'),
      program_areas: JSON.parse(org.program_areas || '[]'),
      government_assistance: JSON.parse(org.government_assistance || '[]'),
      disabilities: JSON.parse(org.disabilities || '[]'),
      target_colleges: JSON.parse(org.target_colleges || '[]'),
      federal_registrations: JSON.parse(org.federal_registrations || '[]'),
      financial_challenges: JSON.parse(org.financial_challenges || '[]')
    };
    
    res.json(parsed);
  } catch (error) {
    console.error('Error getting organization:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create organization
router.post('/', (req, res) => {
  try {
    const id = crypto.randomUUID();
    const data = req.body;
    
    // Stringify JSON fields
    const jsonFields = ['keywords', 'focus_areas', 'program_areas', 'government_assistance', 
                        'disabilities', 'target_colleges', 'federal_registrations', 'financial_challenges'];
    
    jsonFields.forEach(field => {
      if (data[field] && Array.isArray(data[field])) {
        data[field] = JSON.stringify(data[field]);
      }
    });
    
    const columns = ['id', ...Object.keys(data)];
    const placeholders = columns.map(() => '?').join(', ');
    const values = [id, ...Object.values(data)];
    
    req.db.prepare(`
      INSERT INTO organizations (${columns.join(', ')})
      VALUES (${placeholders})
    `).run(...values);
    
    const org = req.db.prepare('SELECT * FROM organizations WHERE id = ?').get(id);
    res.status(201).json(org);
  } catch (error) {
    console.error('Error creating organization:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update organization
router.put('/:id', (req, res) => {
  try {
    const data = req.body;
    
    // Stringify JSON fields
    const jsonFields = ['keywords', 'focus_areas', 'program_areas', 'government_assistance', 
                        'disabilities', 'target_colleges', 'federal_registrations', 'financial_challenges'];
    
    jsonFields.forEach(field => {
      if (data[field] && Array.isArray(data[field])) {
        data[field] = JSON.stringify(data[field]);
      }
    });
    
    const setClause = Object.keys(data).map(key => `${key} = ?`).join(', ');
    const values = [...Object.values(data), req.params.id];
    
    req.db.prepare(`
      UPDATE organizations 
      SET ${setClause}, updated_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `).run(...values);
    
    const org = req.db.prepare('SELECT * FROM organizations WHERE id = ?').get(req.params.id);
    res.json(org);
  } catch (error) {
    console.error('Error updating organization:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete organization
router.delete('/:id', (req, res) => {
  try {
    // Check if organization exists
    const org = req.db.prepare('SELECT id FROM organizations WHERE id = ?').get(req.params.id);
    if (!org) {
      return res.status(404).json({ error: 'Organization not found' });
    }
    
    // Delete related records first (cascade)
    req.db.prepare('DELETE FROM grants WHERE organization_id = ?').run(req.params.id);
    req.db.prepare('DELETE FROM documents WHERE organization_id = ?').run(req.params.id);
    req.db.prepare('DELETE FROM milestones WHERE organization_id = ?').run(req.params.id);
    req.db.prepare('DELETE FROM expenses WHERE organization_id = ?').run(req.params.id);
    req.db.prepare('DELETE FROM contacts WHERE organization_id = ?').run(req.params.id);
    
    // Delete the organization
    req.db.prepare('DELETE FROM organizations WHERE id = ?').run(req.params.id);
    
    res.json({ success: true, message: 'Organization deleted' });
  } catch (error) {
    console.error('Error deleting organization:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get organization's grants
router.get('/:id/grants', (req, res) => {
  try {
    const grants = req.db.prepare(`
      SELECT * FROM grants 
      WHERE organization_id = ? 
      ORDER BY created_at DESC
    `).all(req.params.id);
    
    res.json(grants);
  } catch (error) {
    console.error('Error getting organization grants:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get organization's documents
router.get('/:id/documents', (req, res) => {
  try {
    const documents = req.db.prepare(`
      SELECT * FROM documents 
      WHERE organization_id = ? 
      ORDER BY created_at DESC
    `).all(req.params.id);
    
    res.json(documents);
  } catch (error) {
    console.error('Error getting organization documents:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
