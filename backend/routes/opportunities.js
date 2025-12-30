import express from 'express';
import crypto from 'crypto';

const router = express.Router();

// Search/list funding opportunities
router.get('/', (req, res) => {
  try {
    const { 
      search, 
      state, 
      source, 
      deadline_after,
      deadline_before,
      is_national,
      limit = 50, 
      offset = 0 
    } = req.query;
    
    let query = 'SELECT * FROM funding_opportunities WHERE is_active = 1';
    const params = [];
    
    if (search) {
      query += ' AND (title LIKE ? OR sponsor LIKE ? OR description LIKE ?)';
      const searchTerm = `%${search}%`;
      params.push(searchTerm, searchTerm, searchTerm);
    }
    
    if (state) {
      query += ' AND (state = ? OR is_national = 1)';
      params.push(state);
    }
    
    if (is_national === 'true') {
      query += ' AND is_national = 1';
    }
    
    if (source) {
      query += ' AND source = ?';
      params.push(source);
    }
    
    if (deadline_after) {
      query += ' AND (deadline >= ? OR deadline_type = "rolling")';
      params.push(deadline_after);
    }
    
    if (deadline_before) {
      query += ' AND deadline <= ?';
      params.push(deadline_before);
    }
    
    query += ' ORDER BY deadline ASC NULLS LAST, created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));
    
    const opportunities = req.db.prepare(query).all(...params);
    
    // Parse JSON fields
    const parsed = opportunities.map(opp => ({
      ...opp,
      eligibility_bullets: JSON.parse(opp.eligibility_bullets || '[]'),
      categories: JSON.parse(opp.categories || '[]'),
      keywords: JSON.parse(opp.keywords || '[]'),
      regions: JSON.parse(opp.regions || '[]')
    }));
    
    // Get total count
    let countQuery = 'SELECT COUNT(*) as total FROM funding_opportunities WHERE is_active = 1';
    // ... apply same filters
    
    res.json({
      data: parsed,
      total: parsed.length,
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (error) {
    console.error('Error listing opportunities:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get single opportunity
router.get('/:id', (req, res) => {
  try {
    const opp = req.db.prepare('SELECT * FROM funding_opportunities WHERE id = ?').get(req.params.id);
    
    if (!opp) {
      return res.status(404).json({ error: 'Opportunity not found' });
    }
    
    // Parse JSON fields
    const parsed = {
      ...opp,
      eligibility_bullets: JSON.parse(opp.eligibility_bullets || '[]'),
      categories: JSON.parse(opp.categories || '[]'),
      keywords: JSON.parse(opp.keywords || '[]'),
      regions: JSON.parse(opp.regions || '[]')
    };
    
    res.json(parsed);
  } catch (error) {
    console.error('Error getting opportunity:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create opportunity (for manual entry or crawlers)
router.post('/', (req, res) => {
  try {
    const id = crypto.randomUUID();
    const data = req.body;
    
    // Stringify JSON fields
    const jsonFields = ['eligibility_bullets', 'categories', 'keywords', 'regions'];
    jsonFields.forEach(field => {
      if (data[field] && Array.isArray(data[field])) {
        data[field] = JSON.stringify(data[field]);
      }
    });
    
    const columns = ['id', ...Object.keys(data)];
    const placeholders = columns.map(() => '?').join(', ');
    const values = [id, ...Object.values(data)];
    
    req.db.prepare(`
      INSERT INTO funding_opportunities (${columns.join(', ')})
      VALUES (${placeholders})
    `).run(...values);
    
    const opp = req.db.prepare('SELECT * FROM funding_opportunities WHERE id = ?').get(id);
    res.status(201).json(opp);
  } catch (error) {
    console.error('Error creating opportunity:', error);
    res.status(500).json({ error: error.message });
  }
});

// Bulk import opportunities
router.post('/bulk', (req, res) => {
  try {
    const { opportunities } = req.body;
    
    if (!Array.isArray(opportunities)) {
      return res.status(400).json({ error: 'opportunities must be an array' });
    }
    
    const insertStmt = req.db.prepare(`
      INSERT OR REPLACE INTO funding_opportunities (
        id, title, sponsor, source, source_id, description, 
        eligibility_bullets, amount_min, amount_max, deadline, 
        deadline_type, application_url, is_national, state, 
        categories, keywords, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `);
    
    const insertMany = req.db.transaction((opps) => {
      let count = 0;
      for (const opp of opps) {
        const id = opp.id || crypto.randomUUID();
        insertStmt.run(
          id,
          opp.title,
          opp.sponsor || null,
          opp.source || null,
          opp.source_id || null,
          opp.description || null,
          JSON.stringify(opp.eligibility_bullets || []),
          opp.amount_min || null,
          opp.amount_max || null,
          opp.deadline || null,
          opp.deadline_type || 'unknown',
          opp.application_url || null,
          opp.is_national ? 1 : 0,
          opp.state || null,
          JSON.stringify(opp.categories || []),
          JSON.stringify(opp.keywords || [])
        );
        count++;
      }
      return count;
    });
    
    const imported = insertMany(opportunities);
    
    res.json({ 
      success: true, 
      imported,
      message: `Imported ${imported} opportunities` 
    });
  } catch (error) {
    console.error('Error bulk importing opportunities:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update opportunity
router.put('/:id', (req, res) => {
  try {
    const data = req.body;
    
    // Stringify JSON fields
    const jsonFields = ['eligibility_bullets', 'categories', 'keywords', 'regions'];
    jsonFields.forEach(field => {
      if (data[field] && Array.isArray(data[field])) {
        data[field] = JSON.stringify(data[field]);
      }
    });
    
    const setClause = Object.keys(data).map(key => `${key} = ?`).join(', ');
    const values = [...Object.values(data), req.params.id];
    
    req.db.prepare(`
      UPDATE funding_opportunities 
      SET ${setClause}, updated_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `).run(...values);
    
    const opp = req.db.prepare('SELECT * FROM funding_opportunities WHERE id = ?').get(req.params.id);
    res.json(opp);
  } catch (error) {
    console.error('Error updating opportunity:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete opportunity (soft delete)
router.delete('/:id', (req, res) => {
  try {
    req.db.prepare('UPDATE funding_opportunities SET is_active = 0 WHERE id = ?').run(req.params.id);
    res.json({ success: true, message: 'Opportunity deactivated' });
  } catch (error) {
    console.error('Error deleting opportunity:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get distinct sources for filtering
router.get('/meta/sources', (req, res) => {
  try {
    const sources = req.db.prepare(`
      SELECT DISTINCT source, COUNT(*) as count 
      FROM funding_opportunities 
      WHERE source IS NOT NULL AND is_active = 1
      GROUP BY source 
      ORDER BY count DESC
    `).all();
    
    res.json(sources);
  } catch (error) {
    console.error('Error getting sources:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get distinct states for filtering
router.get('/meta/states', (req, res) => {
  try {
    const states = req.db.prepare(`
      SELECT DISTINCT state, COUNT(*) as count 
      FROM funding_opportunities 
      WHERE state IS NOT NULL AND is_active = 1
      GROUP BY state 
      ORDER BY state ASC
    `).all();
    
    res.json(states);
  } catch (error) {
    console.error('Error getting states:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
