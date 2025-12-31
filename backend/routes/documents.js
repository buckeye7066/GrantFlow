import express from 'express';
import crypto from 'crypto';

const router = express.Router();

router.get('/', (req, res) => {
  try {
    const { organization_id, grant_id, type } = req.query;
    let query = 'SELECT * FROM documents WHERE 1=1';
    const params = [];
    if (organization_id) { query += ' AND organization_id = ?'; params.push(organization_id); }
    if (grant_id) { query += ' AND grant_id = ?'; params.push(grant_id); }
    if (type) { query += ' AND type = ?'; params.push(type); }
    query += ' ORDER BY created_at DESC';
    res.json(req.db.prepare(query).all(...params));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/:id', (req, res) => {
  try {
    const doc = req.db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    res.json(doc);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', (req, res) => {
  try {
    const id = crypto.randomUUID();
    const { organization_id, grant_id, name, type, file_url, status } = req.body;
    req.db.prepare('INSERT INTO documents (id, organization_id, grant_id, name, type, file_url, status) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, organization_id, grant_id, name, type, file_url, status || 'draft');
    res.status(201).json(req.db.prepare('SELECT * FROM documents WHERE id = ?').get(id));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id', (req, res) => {
  try {
    const fields = Object.keys(req.body);
    const values = Object.values(req.body);
    const setClause = fields.map(f => `${f} = ?`).join(', ');
    req.db.prepare(`UPDATE documents SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...values, req.params.id);
    res.json(req.db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    req.db.prepare('DELETE FROM documents WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
