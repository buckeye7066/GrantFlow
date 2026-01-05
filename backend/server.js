import express from 'express';
import cors from 'cors';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import rateLimit from 'express-rate-limit';

// Routes
import organizationsRouter from './routes/organizations.js';
import grantsRouter from './routes/grants.js';
import opportunitiesRouter from './routes/opportunities.js';
import milestonesRouter from './routes/milestones.js';
import documentsRouter from './routes/documents.js';
import expensesRouter from './routes/expenses.js';
import aiRouter from './routes/ai.js';
import anyaRouter from './routes/anya.js';
import profilesRouter from './routes/profiles.js';
import remindersRouter from './routes/reminders.js';
import crawlersRouter from './routes/crawlers.js';
import billingRouter from './routes/billing.js';
import authRouter from './routes/auth.js';
import preferencesRouter from './routes/preferences.js';
import adminRouter from './routes/admin.js';
import discoveryRouter from './routes/discovery.js';
import jwt from 'jsonwebtoken';
import ensureDesignatedProfiles from './utils/ensureDesignatedProfiles.js';
import ensureUserPreferencesTable from './utils/ensureUserPreferencesTable.js';
import { linkAllProfilesToAdmin } from './utils/adminProfileLinks.js';
import { runStartupOperations } from './services/anyaStartupOperations.js';

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || process.env.ANYA_ADMIN_TOKEN || null;
const ADMIN_NAME = process.env.ADMIN_NAME || 'Admin User';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@grantflow.app';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const uploadsDir = join(__dirname, '..', 'uploads');
const distPath = join(__dirname, '..', 'dist');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 8080;

// CORS configuration
const defaultCorsOrigins = [
  'http://localhost:5173',
  'http://localhost:3000',
  'https://grant-flow-three.vercel.app',
  'https://app.axiombiolabs.org',
  'https://www.axiombiolabs.org',
  'https://grantflow-production.up.railway.app',
];
const configuredCorsOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean)
  : null;

const corsOptions = {
  origin: configuredCorsOrigins && configuredCorsOrigins.length > 0 ? configuredCorsOrigins : defaultCorsOrigins,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Token', 'X-Anya-Token'],
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

app.use(express.json({ limit: '50mb' }));
try {
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }
} catch (error) {
  console.warn('Failed to create uploads directory:', error);
}
app.use('/uploads', express.static(uploadsDir));

// Serve static files from Vite build
app.use(express.static(distPath));

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
  // TODO: Remove debug log - console.log('Database schema initialized');
}
try {
  db.prepare('ALTER TABLE profiles ADD COLUMN avatar_url TEXT').run();
} catch (error) {
  // Column already exists - this is expected
  if (!error.message.includes('duplicate column')) {
    console.warn('Failed to add avatar_url column:', error.message);
  }
}
try {
  db.prepare('ALTER TABLE profiles ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE SET NULL').run();
} catch (error) {
  // Column already exists - this is expected
  if (!error.message.includes('duplicate column')) {
    console.warn('Failed to add user_id column:', error.message);
  }
}
try {
  db.prepare('ALTER TABLE crawler_jobs ADD COLUMN result_meta TEXT').run();
} catch (error) {
  // Column already exists - this is expected
  if (!error.message.includes('duplicate column')) {
    console.warn('Failed to add result_meta column:', error.message);
  }
}
try {
  db.prepare('ALTER TABLE crawler_jobs ADD COLUMN retry_count INTEGER DEFAULT 0').run();
} catch (error) {
  // Column already exists - this is expected
  if (!error.message.includes('duplicate column')) {
    console.warn('Failed to add retry_count column:', error.message);
  }
}
try {
  db.prepare('ALTER TABLE crawler_jobs ADD COLUMN last_retry_at DATETIME').run();
} catch (error) {
  // Column already exists - this is expected
  if (!error.message.includes('duplicate column')) {
    console.warn('Failed to add last_retry_at column:', error.message);
  }
}

function ensureCrawlerJobsSupportsProfileEnrichment() {
  try {
    db.prepare(
      `
        INSERT INTO crawler_jobs (id, type, status)
        VALUES ('__schema_test__', 'profile_enrichment', 'queued')
      `,
    ).run()
    db.prepare(
      `
        DELETE FROM crawler_jobs
        WHERE id = '__schema_test__'
      `,
    ).run()
  } catch (error) {
    if (error?.message && error.message.includes('CHECK constraint failed')) {
      const rebuild = db.transaction(() => {
        db.prepare(
          `
            CREATE TABLE crawler_jobs_new (
              id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              started_at DATETIME,
              completed_at DATETIME,
              type TEXT NOT NULL CHECK(type IN (
                'local',
                'scholarship',
                'comprehensive',
                'item_search',
                'avatar_lookup',
                'document_ingest',
                'pipeline_automation',
                'profile_enrichment'
              )),
              status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN (
                'queued',
                'running',
                'completed',
                'failed',
                'cancelled'
              )),
              profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
              organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
              parameters TEXT DEFAULT '{}',
              result_count INTEGER DEFAULT 0,
              result_meta TEXT,
              error TEXT,
              requested_by TEXT,
              retry_count INTEGER DEFAULT 0,
              last_retry_at DATETIME
            )
          `,
        ).run()

        db.prepare(
          `
            INSERT INTO crawler_jobs_new (
              id,
              created_at,
              started_at,
              completed_at,
              type,
              status,
              profile_id,
              organization_id,
              parameters,
              result_count,
              result_meta,
              error,
              requested_by,
              retry_count,
              last_retry_at
            )
            SELECT
              id,
              created_at,
              started_at,
              completed_at,
              type,
              status,
              profile_id,
              organization_id,
              parameters,
              result_count,
              NULL,
              error,
              requested_by,
              COALESCE(retry_count, 0),
              last_retry_at
            FROM crawler_jobs
          `,
        ).run()

        db.prepare('DROP TABLE crawler_jobs').run()
        db.prepare('ALTER TABLE crawler_jobs_new RENAME TO crawler_jobs').run()
        db.prepare('CREATE INDEX IF NOT EXISTS idx_crawler_jobs_status ON crawler_jobs(status)').run()
        db.prepare('CREATE INDEX IF NOT EXISTS idx_crawler_jobs_profile ON crawler_jobs(profile_id)').run()
        db.prepare('CREATE INDEX IF NOT EXISTS idx_crawler_jobs_type ON crawler_jobs(type)').run()
      })

      rebuild()
    }
  }
}

ensureCrawlerJobsSupportsProfileEnrichment()
ensureDesignatedProfiles(db)
linkAllProfilesToAdmin(db)
ensureUserPreferencesTable(db)

const JWT_SECRET = process.env.AUTH_JWT_SECRET || process.env.JWT_SECRET || 'grantflow-dev-secret';

// Make db available to routes
app.use((req, res, next) => {
  req.db = db;
  next();
});

app.use((req, res, next) => {
  const authHeader = req.headers.authorization || '';
  let user = { role: 'guest', profileId: null };
  let handled = false;

  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token) {
      try {
        const payload = jwt.verify(token, JWT_SECRET);
        if (payload?.sid) {
          const sessionRow = db
            .prepare(
              `
                SELECT s.*, u.display_name, u.primary_email, u.is_admin
                FROM user_sessions s
                JOIN users u ON u.id = s.user_id
                WHERE s.id = ?
              `,
            )
            .get(payload.sid);
          if (
            sessionRow &&
            !sessionRow.revoked_at &&
            (!sessionRow.refresh_expires_at || new Date(sessionRow.refresh_expires_at) > new Date())
          ) {
            user = {
              role: sessionRow.is_admin ? 'admin' : 'user',
              is_admin: Boolean(sessionRow.is_admin), // Add is_admin flag for consistency
              userId: sessionRow.user_id,
              profileId: payload.profile_id ?? sessionRow.profile_id ?? null,
              sessionId: sessionRow.id,
              full_name: sessionRow.display_name,
              email: sessionRow.primary_email,
            };
            handled = true;
          }
        }
      } catch (error) {
        // fall through to legacy handling
      }
    }

    if (!handled && token && ADMIN_TOKEN && token === ADMIN_TOKEN) {
      user = { role: 'admin', is_admin: true, full_name: ADMIN_NAME, email: ADMIN_EMAIL };
      handled = true;
    }

    if (!handled && token) {
      try {
        const profile = db
          .prepare('SELECT id, display_name FROM profiles WHERE id = ?')
          .get(token);
        if (profile) {
          user = {
            role: 'user',
            profileId: profile.id,
            profileName: profile.display_name,
          };
          handled = true;
        }
      } catch (error) {
        // Ignore lookup errors and fall back to guest
        console.warn('Failed to lookup profile by token:', error?.message || error);
      }
    }
  }

  req.user = user;
  next();
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

app.get('/api/auth/me', (req, res) => {
  const user = req.user ?? { role: 'guest' };
  if (user.role === 'guest') {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  if (user.userId) {
    const dbUser = db
      .prepare(
        `
          SELECT *
          FROM users
          WHERE id = ?
        `,
      )
      .get(user.userId);

    if (!dbUser) {
      return res.status(401).json({ error: 'User record not found' });
    }

    const profiles = db
      .prepare(
        `
          SELECT id, display_name, organization_id, status
          FROM profiles
          WHERE user_id = ?
          ORDER BY created_at ASC
        `,
      )
      .all(dbUser.id);

    return res.json({
      user: {
        id: dbUser.id,
        display_name: dbUser.display_name,
        primary_email: dbUser.primary_email,
        primary_phone: dbUser.primary_phone,
        avatar_url: dbUser.avatar_url,
        is_admin: Boolean(dbUser.is_admin),
      },
      profiles,
      active_profile_id: user.profileId ?? profiles[0]?.id ?? null,
    });
  }

  if (user.role === 'admin') {
    return res.json({
      role: 'admin',
      full_name: user.full_name ?? ADMIN_NAME,
      email: user.email ?? ADMIN_EMAIL,
    });
  }

  return res.json({
    role: 'user',
    profile_id: user.profileId,
    full_name: user.profileName ?? 'Profile User',
  });
});

// API routes
app.use('/api/auth', authRouter);
app.use('/api/billing', billingRouter);
app.use('/api/organizations', organizationsRouter);
app.use('/api/grants', grantsRouter);
app.use('/api/opportunities', opportunitiesRouter);
app.use('/api/milestones', milestonesRouter);
app.use('/api/documents', documentsRouter);
app.use('/api/expenses', expensesRouter);
app.use('/api/ai', aiRouter);
app.use('/api/anya', anyaRouter); // Keep existing Anya routes for compatibility
app.use('/api/profiles', profilesRouter);
app.use('/api/reminders', remindersRouter);
app.use('/api/crawlers', crawlersRouter);
app.use('/api/preferences', preferencesRouter);
app.use('/api/admin', adminRouter);
app.use('/api', discoveryRouter); // Discovery endpoints (comprehensiveMatch, searchOpportunities, etc.)

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
    const rows = db.prepare(`
      SELECT status, COUNT(*) as count
      FROM grants
      GROUP BY status
    `).all();

    const pipelineKeys = {
      discovered: 0,
      interested: 0,
      drafting: 0,
      app_prep: 0,
      submission_ready: 0,
      submitted: 0,
      awarded: 0,
      rejected: 0
    };

    const statusMap = {
      discovered: 'discovered',
      interested: 'interested',
      drafting: 'drafting',
      revision: 'drafting',
      app_prep: 'app_prep',
      submission_ready: 'submission_ready',
      submitted: 'submitted',
      under_review: 'submitted',
      awarded: 'awarded',
      rejected: 'rejected',
      closed: 'rejected',
      archived: 'rejected'
    };

    rows.forEach((row) => {
      const normalized = statusMap[row.status] || null;
      if (!normalized || pipelineKeys[normalized] === undefined) return;
      pipelineKeys[normalized] += row.count ?? 0;
    });

    res.json(pipelineKeys);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Rate limiter for SPA fallback route to prevent abuse
const spaFallbackLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  limit: 100, // Allow 100 requests per minute per IP (generous for normal browsing)
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: (req) => req.path.startsWith('/api/'), // Skip API routes
});

// Serve React app for all non-API routes (SPA fallback)
app.get('*', spaFallbackLimiter, (req, res, next) => {
  // Skip API routes - let them fall through to 404 handler
  if (req.path.startsWith('/api/')) {
    return next();
  }
  res.sendFile(join(distPath, 'index.html'));
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
  // TODO: Remove debug log - console.log(`GrantFlow API server running on port ${PORT}`);
  // TODO: Remove debug log - console.log(`Database: ${dbPath}`);
  const loggedCorsOrigins = Array.isArray(corsOptions.origin) ? corsOptions.origin : [corsOptions.origin];
  console.log(`CORS origins: ${loggedCorsOrigins.join(', ')}`);
  
  // Start Anya autonomous operations 5 seconds after server is ready
  setTimeout(() => {
    runStartupOperations(db).catch(err => {
      console.error('[Anya Startup] Failed to complete autonomous operations:', err);
    });
  }, 5000);
  // TODO: Remove debug log - console.log(`CORS origins: ${loggedCorsOrigins.join(', ')}`);
  
  // Trigger Anya autonomous operations after startup
  runStartupOperations(db).catch(err => {
    console.error('[startup] Autonomous operations failed:', err);
  });
});

export default app;
