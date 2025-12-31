// Anya routes - maintain compatibility with existing frontend
import express from 'express';

const router = express.Router();

const adminAuth = (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '') || req.headers['x-admin-token'] || req.headers['x-anya-token'];
  const configuredToken = process.env.ADMIN_TOKEN || process.env.ANYA_ADMIN_TOKEN;
  
  if (!configuredToken) return res.status(401).json({ error: 'Admin token not configured' });
  if (!token) return res.status(401).json({ error: 'Missing admin credentials' });
  if (token !== configuredToken) return res.status(403).json({ error: 'Invalid admin credentials' });
  
  next();
};

router.get('/status', adminAuth, (req, res) => {
  res.json({
    status: 'idle',
    currentAction: null,
    lastError: null,
    lastAction: null
  });
});

router.get('/logs', adminAuth, (req, res) => {
  try {
    const { limit = 25 } = req.query;
    const logs = req.db.prepare('SELECT * FROM crawl_logs ORDER BY created_at DESC LIMIT ?').all(parseInt(limit));
    res.json({ entries: logs });
  } catch (error) {
    res.json({ entries: [] });
  }
});

router.post('/scan', adminAuth, (req, res) => {
  res.json({ message: 'Scan initiated', status: 'running' });
});

router.post('/crawl', adminAuth, (req, res) => {
  res.json({ message: 'Crawl initiated', status: 'running' });
});

export default router;
