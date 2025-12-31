import express from 'express';
import crypto from 'crypto';

const router = express.Router();

router.get('/', (req, res) => {
  try {
    const { grant_id, organization_id } = req.query;
    let query = 'SELECT * FROM expenses WHERE 1=1';
    const params = [];
    if (grant_id) { query += ' AND grant_id = ?'; params.push(grant_id); }
    if (organization_id) { query += ' AND organization_id = ?'; params.push(organization_id); }
    query += ' ORDER BY date DESC';
    res.json(req.db.prepare(query).all(...params));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', (req, res) => {
  try {
    const id = crypto.randomUUID();
    const { grant_id, organization_id, description, amount, category, date } = req.body;
    req.db.prepare('INSERT INTO expenses (id, grant_id, organization_id, description, amount, category, date) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, grant_id, organization_id, description, amount, category, date);
    res.status(201).json(req.db.prepare('SELECT * FROM expenses WHERE id = ?').get(id));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id', (req, res) => {
  try {
    const { description, amount, category, date, approved } = req.body;
    req.db.prepare('UPDATE expenses SET description = ?, amount = ?, category = ?, date = ?, approved = ? WHERE id = ?').run(description, amount, category, date, approved ? 1 : 0, req.params.id);
    res.json(req.db.prepare('SELECT * FROM expenses WHERE id = ?').get(req.params.id));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    req.db.prepare('DELETE FROM expenses WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
