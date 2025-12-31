import express from 'express';
import crypto from 'crypto';

const router = express.Router();

router.get('/', (req, res) => {
  try {
    const { grant_id, completed, upcoming } = req.query;
    let query = 'SELECT m.*, g.title as grant_title FROM milestones m LEFT JOIN grants g ON m.grant_id = g.id WHERE 1=1';
    const params = [];
    
    if (grant_id) {
      query += ' AND m.grant_id = ?';
      params.push(grant_id);
    }
    if (completed === 'true') query += ' AND m.completed = 1';
    if (completed === 'false') query += ' AND m.completed = 0';
    if (upcoming === 'true') query += ' AND m.due_date >= date("now") AND m.completed = 0';
    
    query += ' ORDER BY m.due_date ASC';
    const milestones = req.db.prepare(query).all(...params);
    res.json(milestones);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/:id', (req, res) => {
  try {
    const milestone = req.db.prepare('SELECT * FROM milestones WHERE id = ?').get(req.params.id);
    if (!milestone) return res.status(404).json({ error: 'Not found' });
    res.json(milestone);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', (req, res) => {
  try {
    const id = crypto.randomUUID();
    const { grant_id, title, description, due_date, type } = req.body;
    req.db.prepare('INSERT INTO milestones (id, grant_id, title, description, due_date, type) VALUES (?, ?, ?, ?, ?, ?)').run(id, grant_id, title, description, due_date, type);
    const milestone = req.db.prepare('SELECT * FROM milestones WHERE id = ?').get(id);
    res.status(201).json(milestone);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id', (req, res) => {
  try {
    const { title, description, due_date, completed, type } = req.body;
    const completed_date = completed ? new Date().toISOString().split('T')[0] : null;
    req.db.prepare('UPDATE milestones SET title = ?, description = ?, due_date = ?, completed = ?, completed_date = ?, type = ? WHERE id = ?').run(title, description, due_date, completed ? 1 : 0, completed_date, type, req.params.id);
    const milestone = req.db.prepare('SELECT * FROM milestones WHERE id = ?').get(req.params.id);
    res.json(milestone);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.patch('/:id/complete', (req, res) => {
  try {
    const completed_date = new Date().toISOString().split('T')[0];
    req.db.prepare('UPDATE milestones SET completed = 1, completed_date = ? WHERE id = ?').run(completed_date, req.params.id);
    const milestone = req.db.prepare('SELECT * FROM milestones WHERE id = ?').get(req.params.id);
    res.json(milestone);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    req.db.prepare('DELETE FROM milestones WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
