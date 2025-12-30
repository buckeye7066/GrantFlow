import express from 'express';
import cors from 'cors';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

// Routes
import organizationsRouter from './routes/organizations.js';
import grantsRouter from './routes/grants.js';
import opportunitiesRouter from './routes/opportunities.js';
import milestonesRouter from './routes/milestones.js';
import documentsRouter from './routes/documents.js';
import expensesRouter from './routes/expenses.js';
import aiRouter from './routes/ai.js';
import anyaRouter from './routes/anya.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;

// CORS configuration
const corsOrigins = process.env.CORS_ORIGIN?.split(',') || [
  'http://localhost:5173',
  'http://localhost:3000',
  'https://grant-flow-three.vercel.app',
  'https://app.axiombiolabs.org'
];

app.use(cors({
  origin: corsOrigins,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Token', 'X-Anya-Token']
}));

app.use(express.json({ limit: '10mb' }));

// Initialize database
const dataDir = join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = process.env.DATABASE_URL || join(dataDir, 'grantflow.db');
export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// Run schema migration
const schemaPath = join(__dirname, 'db', 'schema.sql');
if (fs.existsSync(schemaPath)) {
  const schema = fs.readFileSync(schemaPath, 'utf8');
  db.exec(schema);
  console.log('Database schema initialized');
}

// Make db available to routes
app.use((req, res, next) => {
  req.db = db;
  next();
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// API routes
app.use('/api/organizations', organizationsRouter);
app.use('/api/grants', grantsRouter);
app.use('/api/opportunities', opportunitiesRouter);
app.use('/api/milestones', milestonesRouter);
app.use('/api/documents', documentsRouter);
app.use('/api/expenses', expensesRouter);
app.use('/api/ai', aiRouter);
app.use('/api/anya', anyaRouter); // Keep existing Anya routes for compatibility

// Stats endpoint for dashboard
app.get('/api/stats', (req, res) => {
  try {
    const orgCount = db.prepare('SELECT COUNT(*) as count FROM organizations').get();
    const grantCount = db.prepare('SELECT COUNT(*) as count FROM grants WHERE status IN (?, ?, ?, ?)').get('interested', 'drafting', 'submitted', 'awarded');
    const totalExpenses = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM expenses').get();
    const upcomingDeadlines = db.prepare(`
      SELECT COUNT(*) as count FROM grants 
      WHERE deadline IS NOT NULL 
      AND deadline >= date('now') 
      AND deadline <= date('now', '+14 days')
      AND status IN ('discovered', 'interested', 'drafting')
    `).get();
    
    res.json({
      organizations: orgCount.count,
      activeGrants: grantCount.count,
      totalExpenses: totalExpenses.total,
      upcomingDeadlines: upcomingDeadlines.count
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Pipeline stats
app.get('/api/pipeline/stats', (req, res) => {
  try {
    const stats = db.prepare(`
      SELECT status, COUNT(*) as count 
      FROM grants 
      GROUP BY status
    `).all();
    
    const pipeline = {
      discovered: 0,
      interested: 0,
      drafting: 0,
      app_prep: 0,
      revision: 0,
      submitted: 0,
      awarded: 0,
      rejected: 0
    };
    
    stats.forEach(s => {
      if (pipeline.hasOwnProperty(s.status)) {
        pipeline[s.status] = s.count;
      }
    });
    
    res.json(pipeline);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Error handling
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`GrantFlow API server running on port ${PORT}`);
  console.log(`Database: ${dbPath}`);
  console.log(`CORS origins: ${corsOrigins.join(', ')}`);
});

export default app;
