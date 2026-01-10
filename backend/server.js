import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';

// Routes
import organizationsRouter from './routes/organizations.js';
import grantsRouter from './routes/grants.js';
import opportunitiesRouter from './routes/opportunities.js';
import programsRouter from './routes/programs.js';
import milestonesRouter from './routes/milestones.js';
import documentsRouter from './routes/documents.js';
import expensesRouter from './routes/expenses.js';
import aiRouter from './routes/ai.js';
import anyaRouter from './routes/anya.js';
import profilesRouter from './routes/profiles.js';
import remindersRouter from './routes/reminders.js';
import crawlersRouter from './routes/crawlers.js';
import realCrawlersRouter from './routes/realCrawlers.js';
import billingRouter from './routes/billing.js';
import authRouter from './routes/auth.js';
import preferencesRouter from './routes/preferences.js';
import adminRouter from './routes/admin.js';
import discoveryRouter from './routes/discovery.js';
import serviceApplicationRouter from './routes/serviceApplication.js';
import statsRouter from './routes/stats.js';
import jwt from 'jsonwebtoken';
import crawlerV2Router from './routes/crawlerV2.js';
import nfProgramsRouter from './routes/nfPrograms.js';
import ensureDesignatedProfiles from './utils/ensureDesignatedProfiles.js';
import ensureUserPreferencesTable from './utils/ensureUserPreferencesTable.js';
import { linkAllProfilesToAdmin } from './utils/adminProfileLinks.js';
import { runStartupOperations } from './services/anyaStartupOperations.js';
import ensureMinimumNationalOpportunities from './utils/ensureMinimumNationalOpportunities.js';
import { errorHandler } from './middleware/errorHandler.js';
import { MAX_JSON_BODY_SIZE } from './config/constants.js';
import { getSafeHealthSummary } from './services/healthSummary.js';

// Validate required environment variables at startup
const requiredEnvVars = ['OPENAI_API_KEY'];
const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingEnvVars.length > 0) {
  console.error('ERROR: Missing required environment variables:', missingEnvVars.join(', '));
  console.error('Please check your .env file and ensure all required variables are set.');
  // Don't exit in development to allow for testing without all services
  if (process.env.NODE_ENV === 'production') {
    process.exit(1);
  } else {
    console.warn('WARNING: Running in non-production mode without all required environment variables.');
  }
}

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

// Request timeout middleware - prevent hanging requests from causing 502 errors
const REQUEST_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT_MS || '30000', 10); // Default 30 seconds
app.use((req, res, next) => {
  // Set a timeout for the request
  req.setTimeout(REQUEST_TIMEOUT, () => {
    console.error('[timeout] Request timeout:', req.method, req.url);
    if (!res.headersSent) {
      res.status(504).json({ 
        error: 'Request timeout',
        error_type: 'timeout',
        message: 'The request took too long to process'
      });
    }
  });
  
  // Set a timeout for the response
  res.setTimeout(REQUEST_TIMEOUT, () => {
    console.error('[timeout] Response timeout:', req.method, req.url);
    if (!res.headersSent) {
      res.status(504).json({ 
        error: 'Response timeout',
        error_type: 'timeout',
        message: 'The server took too long to respond'
      });
    }
  });
  
  next();
});

app.use(express.json({ limit: MAX_JSON_BODY_SIZE }));
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
// Serve the SPA under the configured base path so production builds (base=/grantflow) work locally.
const APP_BASE_PATH = process.env.AUTH_FRONTEND_APP_BASE || process.env.VITE_APP_BASE || '/grantflow';
if (APP_BASE_PATH && APP_BASE_PATH !== '/') {
  app.use(APP_BASE_PATH, express.static(distPath));
}

// Initialize database
const dataDir = join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = process.env.DATABASE_URL || join(dataDir, 'grantflow.db');

// Validate database initialization with proper error handling
let db;
try {
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  
  // Validate database connection on startup
  console.info('[database] Validating database connection...');
  const testResult = db.prepare('SELECT 1 as test').get();
  if (testResult && testResult.test === 1) {
    console.info('[database] Database connection validated successfully');
    console.info('[database] Database path:', dbPath);
  } else {
    throw new Error('Database connection test failed');
  }
} catch (dbError) {
  console.error('[database] CRITICAL: Failed to initialize database:', dbError);
  console.error('[database] Database path:', dbPath);
  
  // Always exit on database errors - don't mask with mock DB
  console.error('[database] Cannot start server without database connection');
  process.exit(1);
}

export { db };

// Run schema migration
const schemaPath = join(__dirname, 'db', 'schema.sql');
if (fs.existsSync(schemaPath)) {
  try {
    const schema = fs.readFileSync(schemaPath, 'utf8');
    db.exec(schema);
    console.info('[database] Schema migrations completed');
  } catch (schemaError) {
    console.error('[database] Error running schema migrations:', schemaError);
    if (process.env.NODE_ENV === 'production') {
      process.exit(1);
    }
  }
}

// Schema migrations - Add columns if they don't exist
// Table and column names are validated against a whitelist for security
const allowedMigrations = [
  { table: 'profiles', column: 'avatar_url', type: 'TEXT' },
  { table: 'profiles', column: 'user_id', type: 'TEXT REFERENCES users(id) ON DELETE SET NULL' },
  { table: 'crawler_jobs', column: 'result_meta', type: 'TEXT' },
  { table: 'crawler_jobs', column: 'retry_count', type: 'INTEGER DEFAULT 0' },
  { table: 'crawler_jobs', column: 'last_retry_at', type: 'DATETIME' },
  // Positive classification for "REAL" opportunity invariants
  { table: 'funding_opportunities', column: 'record_origin', type: "TEXT DEFAULT 'live_crawl'" },
  // Funding opportunity metadata (needed for verified ingestion + invariants)
  { table: 'funding_opportunities', column: 'contact_info', type: 'TEXT' },
  { table: 'funding_opportunities', column: 'type', type: "TEXT DEFAULT 'OPPORTUNITY'" },
  { table: 'funding_opportunities', column: 'evidence_url', type: 'TEXT' },
  { table: 'funding_opportunities', column: 'last_verified_at', type: 'DATETIME' }
];

const validTables = new Set(['profiles', 'crawler_jobs', 'users', 'organizations', 'grants', 'funding_opportunities']);
const validColumnPattern = /^[a-z_]+$/;

allowedMigrations.forEach(({ table, column, type }) => {
  // Validate table and column names to prevent SQL injection
  if (!validTables.has(table) || !validColumnPattern.test(column)) {
    console.error(`Migration error: Invalid table "${table}" or column "${column}"`);
    return;
  }
  
  try {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`).run();
  } catch (error) {
    // Column already exists or other error - log only if not duplicate column error
    if (!error.message.includes('duplicate column')) {
      console.warn(`Migration warning for ${table}.${column}:`, error.message);
    }
  }
});

function ensureCrawlerJobsSupportsAllTypes() {
  const testTypes = ['profile_enrichment', 'national']
  let needsRebuild = false

  for (const type of testTypes) {
    try {
      const testId = `__schema_test_${type}__`
      db.prepare(
        `
          INSERT INTO crawler_jobs (id, type, status)
          VALUES (?, ?, 'queued')
        `,
      ).run(testId, type)
      db.prepare(
        `
          DELETE FROM crawler_jobs
          WHERE id = ?
        `,
      ).run(testId)
    } catch (error) {
      if (error?.message && error.message.includes('CHECK constraint failed')) {
        needsRebuild = true
        break
      }
    }
  }

  if (!needsRebuild) return

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
            'national',
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
          result_meta,
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

ensureCrawlerJobsSupportsAllTypes()
ensureDesignatedProfiles(db)
linkAllProfilesToAdmin(db)
ensureUserPreferencesTable(db)

// Check funding opportunities count and provide guidance
try {
  const oppCount = db.prepare('SELECT COUNT(*) as count FROM funding_opportunities WHERE is_active = 1').get();
  if (oppCount && oppCount.count === 0) {
    console.info('[startup] No funding opportunities found, auto-seeding...');
    
    // Load opportunity files
    const crawlersDir = join(__dirname, 'data', 'crawlers');
    const files = [
      { path: join(crawlersDir, 'real_funding_opportunities.json'), type: 'structured' },
      { path: join(crawlersDir, 'scholarship_opportunities.json'), type: 'array' },
      { path: join(crawlersDir, 'local_opportunities.json'), type: 'array' },
      { path: join(crawlersDir, 'item_funding_sources.json'), type: 'array' },
    ];
    
    const allOpportunities = [];
    for (const file of files) {
      try {
        if (fs.existsSync(file.path)) {
          const content = fs.readFileSync(file.path, 'utf8');
          const data = JSON.parse(content);
          if (file.type === 'structured') {
            Object.values(data).forEach(category => {
              if (Array.isArray(category)) allOpportunities.push(...category);
            });
          } else if (Array.isArray(data)) {
            allOpportunities.push(...data);
          }
        }
      } catch (e) {
        console.warn(`[startup] Failed to load ${file.path}:`, e.message);
      }
    }
    
    if (allOpportunities.length > 0) {
      const upsert = db.prepare(`
        INSERT INTO funding_opportunities (
          id, source, source_id, title, sponsor, description,
          application_url, source_url, deadline, amount_min, amount_max,
          categories, keywords, eligibility_bullets, match_reasons,
          state, requires_match, requires_501c3, is_active, is_national, record_origin,
          opportunity_type, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO NOTHING
      `);
      
      const transaction = db.transaction(() => {
        for (const opp of allOpportunities) {
          try {
            const id = opp.id || crypto.randomUUID();
            const isNational = opp.is_national === true || opp.is_national === 1 || opp.state === 'nationwide';
            upsert.run(
              id, opp.source || 'seeded_real', opp.source_id || id,
              opp.title || opp.program_name, opp.sponsor || opp.funder, opp.description || opp.summary,
              opp.application_url || opp.url, opp.url || opp.source_url || opp.application_url, opp.deadline,
              opp.amount_min || opp.award_floor, opp.amount_max || opp.award_ceiling,
              JSON.stringify(opp.categories || []), JSON.stringify(opp.keywords || []),
              JSON.stringify(opp.eligibility_bullets || []), JSON.stringify(opp.match_reasons || []),
              opp.state || (isNational ? 'nationwide' : null),
              opp.requires_match ? 1 : 0, opp.requires_501c3 ? 1 : 0, isNational ? 1 : 0,
              'curated_verified',
              opp.opportunity_type || 'grant'
            );
          } catch (e) { /* ignore individual errors */ }
        }
      });
      
      transaction();
      const newCount = db.prepare('SELECT COUNT(*) as count FROM funding_opportunities WHERE is_active = 1').get();
      console.info(`[startup] Seeded ${newCount.count} funding opportunities`);
    }
  } else {
    console.info(`[startup] Found ${oppCount.count} existing funding opportunities`);
  }
} catch (error) {
  console.warn('[startup] Error checking opportunities count:', error.message);
}

function parseBoolEnv(value) {
  if (value == null) return null
  const v = String(value).trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(v)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(v)) return false
  return null
}

// Ensure at least N REAL national opportunities are available (visible from any ZIP).
// - Non-prod: default ON (local reliability).
// - Prod: default OFF unless first-boot (no opportunities at all) or explicitly enabled.
try {
  const minimum = Number.parseInt(process.env.MIN_NATIONAL_OPPORTUNITIES || '3', 10)
  const min = Number.isFinite(minimum) ? minimum : 3

  const isProd = process.env.NODE_ENV === 'production'
  const flag = parseBoolEnv(process.env.ENABLE_MIN_NATIONAL_ENSURE)
  const activeTotalRow = db
    .prepare('SELECT COUNT(*) as count FROM funding_opportunities WHERE is_active = 1')
    .get()
  const activeTotal = Number(activeTotalRow?.count ?? 0)

  let shouldEnsure = false
  let enabledBy = 'disabled'

  if (flag === true) {
    shouldEnsure = true
    enabledBy = 'flag'
  } else if (flag === false) {
    shouldEnsure = false
    enabledBy = 'flag_off'
  } else if (!isProd) {
    shouldEnsure = true
    enabledBy = 'default_nonprod'
  } else if (activeTotal === 0) {
    shouldEnsure = true
    enabledBy = 'first_boot'
  }

  if (shouldEnsure) {
    const ensured = ensureMinimumNationalOpportunities(db, min)
    const backfilled = (ensured.events || []).some((e) => e.type === 'backfill' || e.type === 'schema_backfill')

    const evt = {
      event: 'min_national_ensure',
      enabled_by: enabledBy,
      minimum: ensured.minimum,
      ok: ensured.ok,
      total: ensured.total,
      ensured: ensured.ensured,
      backfilled,
      sources: (ensured.events || []).filter((e) => e.type === 'backfill').map((e) => e.source),
    }

    // Structured log for observability (backfill is acceptable but must be visible)
    console.info('[startup]', JSON.stringify(evt))

    if (!ensured.ok) {
      console.warn(`[startup] National minimum not met: have ${ensured.total}, need ${ensured.minimum}`)
    }
  } else {
    console.info('[startup]', JSON.stringify({ event: 'min_national_ensure', enabled_by: enabledBy, minimum: min, skipped: true }))
  }
} catch (error) {
  console.warn('[startup] Failed to ensure national minimum opportunities:', error?.message || error)
}

// Auto-seed grants disabled temporarily to debug server crash
// TODO: Re-enable after fixing
console.info('[startup] Grant seeding disabled for debugging');

const JWT_SECRET = process.env.AUTH_JWT_SECRET || process.env.JWT_SECRET || 'grantflow-dev-secret';

// Make db available to routes
app.use((req, res, next) => {
  req.db = db;
  next();
});

app.use((req, res, next) => {
  const authHeader = req.headers.authorization || '';
  const xAdminToken = req.headers['x-admin-token'];
  const xAnyaToken = req.headers['x-anya-token'];
  let user = { role: 'guest', profileId: null };
  let handled = false;

  // 1. Check X-Admin-Token
  const expectedAdminToken = ADMIN_TOKEN;
  const expectedBulkKey = process.env.BULK_POPULATE_KEY || 'grantflow-bulk-2026';
  
  if (!handled && xAdminToken && ((expectedAdminToken && xAdminToken === expectedAdminToken) || xAdminToken === expectedBulkKey)) {
    user = { role: 'admin', is_admin: true, full_name: ADMIN_NAME, email: ADMIN_EMAIL };
    handled = true;
  }

  // 2. Check X-Anya-Token (autonomous bot)
  if (!handled && xAnyaToken && process.env.ANYA_API_KEY && xAnyaToken === process.env.ANYA_API_KEY) {
    user = { role: 'admin', is_admin: true, full_name: 'Anya Assistant', email: 'anya@grantflow.app' };
    handled = true;
  }

  // 3. Check Authorization Bearer token
  if (!handled && authHeader.startsWith('Bearer ')) {
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
              is_admin: Boolean(sessionRow.is_admin),
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

// Health check with dependency checks
// Health check endpoint (v3.0 - complete county data)
app.get('/health', (req, res) => {
  const health = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    dependencies: {
      database: 'unknown',
      openai: 'unknown'
    }
  };
  
  // Check database connection
  try {
    db.prepare('SELECT 1').get();
    health.dependencies.database = 'healthy';
  } catch (error) {
    health.dependencies.database = 'unhealthy';
    health.status = 'degraded';
  }
  
  // Check if OpenAI API key is configured
  health.dependencies.openai = process.env.OPENAI_API_KEY ? 'configured' : 'not configured';
  
  const statusCode = health.status === 'healthy' ? 200 : 503;
  res.status(statusCode).json(health);
});

// Authentication diagnostics endpoint
app.get('/api/auth/diagnostics', (req, res) => {
  const diagnostics = {
    status: 'operational',
    timestamp: new Date().toISOString(),
    auth: {
      jwtSecret: process.env.AUTH_JWT_SECRET || process.env.JWT_SECRET ? 'configured' : 'not configured',
      routes: 'registered',
      database: 'unknown',
      adminTokenConfigured: Boolean(process.env.ADMIN_TOKEN || process.env.ANYA_ADMIN_TOKEN),
      bulkKeyConfigured: Boolean(process.env.BULK_POPULATE_KEY),
    },
    providers: {}
  };

  // Check database connection
  try {
    db.prepare('SELECT COUNT(*) as count FROM users').get();
    diagnostics.auth.database = 'connected';
  } catch (error) {
    diagnostics.auth.database = 'error: ' + error.message;
    diagnostics.status = 'degraded';
  }

  // Check OAuth provider configurations
  const providers = ['google', 'facebook', 'yahoo'];
  providers.forEach(provider => {
    const upper = provider.toUpperCase();
    const hasClientId = Boolean(
      process.env[`AUTH_${upper}_CLIENT_ID`] || 
      process.env[`${upper}_CLIENT_ID`] || 
      process.env[`OAUTH_${upper}_CLIENT_ID`]
    );
    const hasClientSecret = Boolean(
      process.env[`AUTH_${upper}_CLIENT_SECRET`] || 
      process.env[`${upper}_CLIENT_SECRET`] || 
      process.env[`OAUTH_${upper}_CLIENT_SECRET`]
    );
    diagnostics.providers[provider] = {
      configured: hasClientId && hasClientSecret,
      clientId: hasClientId ? 'present' : 'missing',
      clientSecret: hasClientSecret ? 'present' : 'missing'
    };
  });

  const statusCode = diagnostics.status === 'operational' ? 200 : 503;
  res.status(statusCode).json(diagnostics);
});

// Rate limiter for /api/auth/me endpoint to prevent abuse
const authMeLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  limit: 100, // Allow 100 requests per 5 minutes per IP
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});

app.get('/api/auth/me', authMeLimiter, (req, res) => {
  try {
    const user = req.user ?? { role: 'guest' };
    if (user.role === 'guest') {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    if (user.userId) {
      let dbUser, profiles;
      
      try {
        dbUser = db
          .prepare(
            `
              SELECT *
              FROM users
              WHERE id = ?
            `,
          )
          .get(user.userId);
      } catch (dbError) {
        console.error('[/api/auth/me] Database error fetching user:', dbError);
        return res.status(500).json({ 
          error: 'Database error occurred',
          error_type: 'database_error',
          details: process.env.NODE_ENV !== 'production' ? dbError.message : undefined
        });
      }

      if (!dbUser) {
        return res.status(401).json({ error: 'User record not found' });
      }

      try {
        profiles = db
          .prepare(
            `
              SELECT id, display_name, organization_id, status
              FROM profiles
              WHERE user_id = ?
              ORDER BY created_at ASC
            `,
          )
          .all(dbUser.id);
      } catch (dbError) {
        console.error('[/api/auth/me] Database error fetching profiles:', dbError);
        // Return user data without profiles if profiles query fails
        profiles = [];
      }

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
  } catch (error) {
    console.error('[/api/auth/me] Unexpected error:', error);
    return res.status(500).json({ 
      error: 'An unexpected error occurred',
      error_type: 'internal_error',
      details: process.env.NODE_ENV !== 'production' ? error.message : undefined
    });
  }
});

// API routes
app.use('/api/auth', authRouter);
app.use('/api/service-application', serviceApplicationRouter);
app.use('/api/billing', billingRouter);
app.use('/api/stats', statsRouter);
app.use('/api/organizations', organizationsRouter);
app.use('/api/grants', grantsRouter);
app.use('/api/opportunities', opportunitiesRouter);
app.use('/api/programs', programsRouter);
app.use('/api/milestones', milestonesRouter);
app.use('/api/documents', documentsRouter);
app.use('/api/expenses', expensesRouter);
app.use('/api/ai', aiRouter);
app.use('/api/anya', anyaRouter); // Keep existing Anya routes for compatibility
app.use('/api/profiles', profilesRouter);
app.use('/api/reminders', remindersRouter);
app.use('/api/crawlers', crawlersRouter);
app.use('/api/real-crawlers', realCrawlersRouter);
app.use('/api/preferences', preferencesRouter);

// Public health endpoint - safe for non-admin users
app.get('/api/health', (req, res) => {
  try {
    const healthSummary = getSafeHealthSummary(db);
    const statusCode = healthSummary.status === 'healthy' ? 200 : 503;
    res.status(statusCode).json(healthSummary);
  } catch (error) {
    console.error('[/api/health] Error:', error);
    res.status(500).json({
      timestamp: new Date().toISOString(),
      status: 'error',
      counts: { opportunities: 0, recentFailures: 0 },
      summary: 'Failed to retrieve health information'
    });
  }
});

app.use('/api/admin', adminRouter);
app.use('/api', discoveryRouter); // Discovery endpoints (comprehensiveMatch, searchOpportunities, etc.)
app.use('/api/crawler-v2', crawlerV2Router);
app.use('/api/nf-programs', nfProgramsRouter);

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
    console.error('Pipeline stats error:', error);
    res.status(500).json({ error: 'Internal server error' });
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

// Use centralized error handler middleware
app.use(errorHandler);

// Error handling for route errors
app.use((err, req, res, next) => {
  console.error('[server] Unhandled error:', {
    message: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    body: req.body,
    headers: {
      'content-type': req.headers['content-type'],
      'authorization': req.headers.authorization ? '[REDACTED]' : undefined
    }
  });
  
  const isProduction = process.env.NODE_ENV === 'production';
  const statusCode = err.statusCode || err.status || 500;
  
  res.status(statusCode).json({ 
    error: isProduction ? 'Internal server error' : err.message,
    error_type: err.error_type || 'internal_error',
    ...(isProduction ? {} : { stack: err.stack })
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Graceful shutdown handling
function gracefulShutdown(signal) {
  console.log(`\nReceived ${signal}, closing server gracefully...`);
  
  server.close(() => {
    console.log('HTTP server closed');
    
    try {
      db.close();
      console.log('Database connection closed');
    } catch (error) {
      console.error('Error closing database:', error);
    }
    
    console.log('Graceful shutdown complete');
    process.exit(0);
  });
  
  // Force close after 10 seconds
  setTimeout(() => {
    console.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

const server = app.listen(PORT, '0.0.0.0', () => {
  const loggedCorsOrigins = Array.isArray(corsOptions.origin) ? corsOptions.origin : [corsOptions.origin];
  console.log(`CORS origins: ${loggedCorsOrigins.join(', ')}`);
  const actualPort = server.address()?.port ?? PORT;
  console.log('[Server] Ready on port', actualPort);
  
  // Start Anya autonomous operations 5 seconds after server is ready
  if (process.env.ANYA_AUTONOMOUS_ENABLED === 'true') {
    setTimeout(() => {
      if (process.env.ANYA_RUN_ON_STARTUP === 'true') {
        // Run full autonomous operations (code scan, tests, crawlers)
        import('./services/anyaAutonomousScheduler.js').then(({ runOnStartup }) => {
          console.log('[Anya] Starting autonomous operations on server startup...');
          runOnStartup(db).catch(err => {
            console.error('[Anya] Failed to complete autonomous operations:', err);
          });
        });
      } else {
        // Run original crawler operations only
        runStartupOperations(db).catch(err => {
          console.error('[Anya] Failed to complete crawler operations:', err);
        });
      }
    }, 5000);
  } else {
    console.log('[Anya] Autonomous operations disabled (set ANYA_AUTONOMOUS_ENABLED=true to enable)');
  }

  // Optional: continuous national programs crawler (Track A/B programs)
  if (process.env.NATIONAL_PROGRAMS_CRAWLER_ENABLED === 'true') {
    const intervalMinutes = Number.parseInt(
      process.env.NATIONAL_PROGRAMS_CRAWLER_INTERVAL_MINUTES || '360',
      10,
    )
    const maxUrls = Number.parseInt(process.env.NATIONAL_PROGRAMS_MAX_URLS || '200', 10)
    const maxDepth = Number.parseInt(process.env.NATIONAL_PROGRAMS_MAX_DEPTH || '2', 10)

    setTimeout(() => {
      import('./services/nationalPrograms/continuousRunner.js')
        .then(({ startNationalProgramsCrawler }) => {
          console.log(
            `[NationalPrograms] Continuous crawler enabled (every ${intervalMinutes} minutes, maxUrls=${maxUrls}, maxDepth=${maxDepth})`,
          )
          startNationalProgramsCrawler({
            db,
            uploadDir: uploadsDir,
            intervalMinutes,
            maxUrls,
            maxDepth,
          })
        })
        .catch((err) => {
          console.error('[NationalPrograms] Failed to start continuous crawler:', err?.message || err)
        })
    }, 8000)
  } else {
    console.log(
      '[NationalPrograms] Continuous crawler disabled (set NATIONAL_PROGRAMS_CRAWLER_ENABLED=true to enable)',
    )
  }
});

export default app;
