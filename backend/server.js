// Load `.env` from the current working directory. Use override so `.env` wins over any stale
// machine-level OPENAI_API_KEY values during local development.
import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import fs from 'fs';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import { db } from './db/index.js';

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
import matchingRouter from './routes/matching.js';
import grantMonitoringRouter from './routes/grantMonitoring.js';
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
import seedAssistanceDirectories from './utils/seedAssistanceDirectories.js';
import { errorHandler } from './middleware/errorHandler.js';
import { MAX_JSON_BODY_SIZE } from './config/constants.js';
import { getSafeHealthSummary } from './services/diagnosticsService.js';
import { initializeFeatureFlags } from './services/featureFlagService.js';
import { logAuditEvent, AUDIT_CATEGORIES, SEVERITY } from './services/auditService.js';
import { decryptRuntimeSecret } from './utils/runtimeSecrets.js';
import { seedBaselineFromRepo } from './utils/seedBaselineFromRepo.js';
import { assertFundingApiKeys, getFundingApiKeyPresence } from './src/config/apiKeys.js';

// Validate critical environment variables at startup.
// NOTE: OpenAI is intentionally OPTIONAL for core app flows (auth/profile/opportunities).
// The server can restore OPENAI_API_KEY from app_runtime_secrets later (hosted emergency stopgap),
// and even without OpenAI the app should still boot and allow login.
const requiredEnvVars = [];
const missingEnvVars = requiredEnvVars.filter((varName) => !process.env[varName]);

if (missingEnvVars.length > 0) {
  console.error('ERROR: Missing required environment variables:', missingEnvVars.join(', '));
  console.error('Please check your environment variables and redeploy.');
  if (process.env.NODE_ENV === 'production') {
    process.exit(1);
  } else {
    console.warn('WARNING: Running in non-production mode without all required environment variables.');
  }
}

// Funding API keys (safe presence only). Never print key values.
try {
  console.info('[funding-api-keys] presence', getFundingApiKeyPresence())
  // Enforced only when FUNDING_APIS_REQUIRE_KEYS=true
  assertFundingApiKeys()
} catch (error) {
  // If enforcement is OFF, assertFundingApiKeys returns and we never land here.
  // If enforcement is ON and we are not exiting (non-prod), we still want a clear warning.
  console.warn('[funding-api-keys] startup check failed:', error?.message || String(error))
}

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || process.env.ANYA_ADMIN_TOKEN || null;
const ADMIN_NAME = process.env.ADMIN_NAME || 'Admin User';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@grantflow.app';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Uploads must live on a persistent volume in production (Railway Volume).
// Set UPLOADS_DIR=/data/uploads (or your mount path) in Railway.
// Default to backend/uploads for local/dev so routes and serving agree.
const uploadsDir = process.env.UPLOADS_DIR
  ? resolve(process.env.UPLOADS_DIR)
  : join(__dirname, 'uploads');
// Backward-compat: some older builds stored uploads at repo-root `/uploads`.
const legacyUploadsDir = join(__dirname, '..', 'uploads');
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
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Token', 'X-Anya-Token', 'X-Request-Id'],
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// Request ID (correlate client errors with server logs)
app.use((req, res, next) => {
  const headerId = req.headers['x-request-id'];
  const requestId =
    (typeof headerId === 'string' && headerId.trim()) ||
    (Array.isArray(headerId) && typeof headerId[0] === 'string' && headerId[0].trim()) ||
    crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
});

// Standardize error envelope for JSON OBJECT responses (backward compatible):
// - Success responses are NOT modified (avoid changing public success shapes)
// - Error responses (HTTP >= 400) get `{ ok: false, request_id, ... }` if missing
app.use((req, res, next) => {
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    const isObject = body && typeof body === 'object' && !Array.isArray(body);
    if (!isObject) {
      return originalJson(body);
    }

    const status = res.statusCode || 200;
    if (status < 400) {
      return originalJson(body);
    }

    const requestId = req.requestId || null;

    const normalized = Object.prototype.hasOwnProperty.call(body, 'ok')
      ? body
      : { ok: false, ...body };

    if (requestId && !Object.prototype.hasOwnProperty.call(normalized, 'request_id')) {
      normalized.request_id = requestId;
    }

    return originalJson(normalized);
  };
  next();
});

// Request timeout middleware - prevent hanging requests from causing 502 errors
const REQUEST_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT_MS || '30000', 10); // Default 30 seconds
app.use((req, res, next) => {
  // Set a timeout for the request
  req.setTimeout(REQUEST_TIMEOUT, () => {
    console.error('[timeout] Request timeout:', req.method, req.url);
    if (!res.headersSent) {
      res.status(504).json({ 
        ok: false,
        request_id: req.requestId || null,
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
        ok: false,
        request_id: req.requestId || null,
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
// IMPORTANT: Missing uploads must return 404 (not SPA index.html).
// Serve both current + legacy upload locations, then terminate with a strict 404.
app.use('/uploads', express.static(uploadsDir, { index: false }));
try {
  if (legacyUploadsDir !== uploadsDir && fs.existsSync(legacyUploadsDir)) {
    app.use('/uploads', express.static(legacyUploadsDir, { index: false }));
  }
} catch {
  // ignore legacy-dir probing failures
}
app.use('/uploads', (_req, res) => res.status(404).send('Not Found'));

async function repairMissingUploadAvatars({ db, uploadsDir }) {
  // If the DB references upload URLs that no longer exist on disk (common after an ephemeral volume reset),
  // browsers will spam 404s. The correct fix is to stop referencing non-existent files.
  try {
    const rows = await db
      .prepare(
        `
          SELECT id, avatar_url
          FROM profiles
          WHERE avatar_url IS NOT NULL
            AND TRIM(avatar_url) <> ''
        `,
      )
      .all()

    let repaired = 0
    for (const row of rows) {
      const raw = String(row.avatar_url || '').trim()
      if (!raw) continue

      let pathname = raw
      try {
        if (/^https?:\/\//i.test(raw)) pathname = new URL(raw).pathname
      } catch {
        // keep raw as-is
      }

      if (!pathname.includes('/uploads/')) continue
      const fileName = pathname.split('/').pop()
      if (!fileName) continue

      const fullPath = join(uploadsDir, fileName)
      if (fs.existsSync(fullPath)) continue

      // Remove the reference so the frontend uses its built-in non-upload fallback.
      await db.prepare('UPDATE profiles SET avatar_url = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.id)
      repaired += 1
    }

    if (repaired > 0) {
      console.warn('[startup] repaired missing upload avatars', { repaired })
    }
  } catch (error) {
    console.warn('[startup] failed to repair missing upload avatars:', error?.message || error)
  }
}

async function repairInvalidDocumentStatuses(db) {
  // Postgres uses a CHECK constraint on documents.status; if any legacy rows exist (e.g. "processed"),
  // *any* UPDATE touching that row will fail until status is repaired.
  const allowed = ['draft', 'review', 'final', 'submitted']
  try {
    await db
      .prepare(
        `
          UPDATE documents
          SET status = 'draft',
              updated_at = CURRENT_TIMESTAMP
          WHERE status IS NOT NULL
            AND status NOT IN ('draft','review','final','submitted')
        `,
      )
      .run()
  } catch (error) {
    // Non-fatal: some deployments may not have the documents table yet.
    console.warn('[startup] Failed to repair invalid document statuses:', error?.message || error)
  }
}

// Serve static files from Vite build
app.use(express.static(distPath));
// Serve the SPA under the configured base path so production builds (base=/grantflow) work locally.
const APP_BASE_PATH = process.env.AUTH_FRONTEND_APP_BASE || process.env.VITE_APP_BASE || '/grantflow';
if (APP_BASE_PATH && APP_BASE_PATH !== '/') {
  const normalizedBase = String(APP_BASE_PATH).replace(/\/+$/, '');
  // Expose uploads under the same base path (common when reverse proxies only route /grantflow/*).
  app.use(`${normalizedBase}/uploads`, express.static(uploadsDir, { index: false }));
  try {
    if (legacyUploadsDir !== uploadsDir && fs.existsSync(legacyUploadsDir)) {
      app.use(`${normalizedBase}/uploads`, express.static(legacyUploadsDir, { index: false }));
    }
  } catch {
    // ignore legacy-dir probing failures
  }
  app.use(`${normalizedBase}/uploads`, (_req, res) => res.status(404).send('Not Found'));

  app.use(APP_BASE_PATH, express.static(distPath));
}

// Validate database connection on startup (works for both sqlite and postgres)
try {
  console.info('[database] Validating database connection...');
  const hc = await db.healthcheck();
  if (!hc?.ok) {
    throw new Error(hc?.error || 'Database healthcheck failed')
  }
  console.info('[database] Database connection validated successfully', {
    dialect: db.dialect,
    path: db.path ?? null,
  });
} catch (dbError) {
  console.error('[database] CRITICAL: Failed to initialize database:', dbError);
  // Production safety: do not hard-exit. A hard exit yields a perpetual 502 and blocks recovery via Admin UI.
  // We keep the process alive so `/api/health` and admin diagnostics can surface the failure reason.
  console.error('[database] Continuing startup in degraded mode (DB unavailable).');
  app.locals.db_startup_error = dbError instanceof Error ? dbError.message : String(dbError)
}

// NOTE: Schema/migrations should be applied via `npm run migrate` in production.
// We keep the legacy "apply schema on startup" behavior only for sqlite local dev.
const shouldAutoMigrate =
  String(process.env.DB_AUTO_MIGRATE || '').toLowerCase() === 'true' ||
  (db.dialect === 'sqlite' && process.env.NODE_ENV !== 'production');

if (shouldAutoMigrate) {
  const schemaPath = join(__dirname, 'db', 'schema.sql');
  if (fs.existsSync(schemaPath)) {
    try {
      const schema = fs.readFileSync(schemaPath, 'utf8');
      await db.exec(schema);
      console.info('[database] Schema applied (auto-migrate enabled)', { dialect: db.dialect });
    } catch (schemaError) {
      console.error('[database] Error running schema migrations:', schemaError);
      // Do not hard-exit; keep the service reachable for diagnostics.
    }
  }
}

// Load persisted runtime secrets (encrypted) if missing from environment.
// This is intended as an emergency stopgap for hosted environments where env var updates are delayed.
try {
  const currentKey = String(process.env.OPENAI_API_KEY || '').trim()
  const looksMissing =
    !currentKey ||
    currentKey === 'YOUR_OPENAI_API_KEY' ||
    currentKey.includes('*')

  if (looksMissing) {
    const row = await db
      .prepare(
        `
          SELECT value_ciphertext, iv, tag, updated_at
          FROM app_runtime_secrets
          WHERE key = 'OPENAI_API_KEY'
          LIMIT 1
        `,
      )
      .get()

    if (row?.value_ciphertext && row?.iv && row?.tag) {
      const restored = decryptRuntimeSecret(row)
      if (restored && String(restored).trim()) {
        process.env.OPENAI_API_KEY = String(restored).trim()
        console.info('[startup] Restored OPENAI_API_KEY from app_runtime_secrets', {
          updated_at: row.updated_at ?? null,
          prefix: `${String(process.env.OPENAI_API_KEY).slice(0, 7)}...`,
        })
      }
    }
  }
} catch (error) {
  console.warn('[startup] Failed to restore runtime secrets:', error?.message || error)
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
  { table: 'funding_opportunities', column: 'evidence_url', type: 'TEXT' },
  { table: 'funding_opportunities', column: 'last_verified_at', type: 'DATETIME' },
  // Link documents to per-school university applications (student profiles)
  { table: 'documents', column: 'university_application_id', type: 'TEXT' },
  { table: 'documents', column: 'university_application_name', type: 'TEXT' },
];

const validTables = new Set(['profiles', 'crawler_jobs', 'users', 'organizations', 'grants', 'funding_opportunities', 'documents']);
const validColumnPattern = /^[a-z_]+$/;

// This legacy auto-migration is SQLite-only. Postgres must be migrated deterministically via SQL migrations.
if (db.dialect === 'sqlite') {
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
} else {
  console.info('[database] Skipping legacy column auto-migrations (dialect != sqlite)');
}

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

if (db.dialect === 'sqlite') {
  ensureCrawlerJobsSupportsAllTypes()
}
// Restore baseline data (profiles + sections, plus other seed tables if DB appears empty).
// This makes the app self-heal after an ephemeral DB reset, so "real profiles" reappear on next login.
try {
  const mode = String(process.env.BASELINE_SEED_MODE || '').trim().toLowerCase() || 'auto'
  const result = await seedBaselineFromRepo(db, {
    mode: mode === 'force' ? 'force' : mode === 'off' ? 'off' : 'auto',
  })
  console.info('[startup] baseline seed', {
    ok: result.ok,
    skipped: result.skipped,
    reason: result.reason ?? null,
    seed_path: result.seed_path ?? null,
    exported_at: result.exported_at ?? null,
    before: result.before ?? null,
    after: result.after ?? null,
    decisions: result.decisions ?? null,
  })
} catch (error) {
  // Fallback to designated profiles so the server can still boot, but log loudly.
  console.error('[startup] Failed to seed baseline from repo. Falling back to designated profiles.', {
    error: error?.message || String(error),
  })
  await ensureDesignatedProfiles(db)
}
// Always ensure designated profiles exist (idempotent); baseline seed may not include newer fixtures.
await ensureDesignatedProfiles(db)
await linkAllProfilesToAdmin(db)
await ensureUserPreferencesTable(db)
await repairInvalidDocumentStatuses(db)
await repairMissingUploadAvatars({ db, uploadsDir })

// Check funding opportunities count and provide guidance
if (db.dialect === 'sqlite') {
  try {
    const oppCount = db.prepare('SELECT COUNT(*) as count FROM funding_opportunities WHERE is_active = 1').get();
    if (oppCount && oppCount.count === 0) {
      console.info('[startup] No funding opportunities found, auto-seeding...');
      try {
        const { seedRealOpportunities } = await import('./utils/seedRealOpportunities.js')
        await seedRealOpportunities(db)
        const newCount = db.prepare('SELECT COUNT(*) as count FROM funding_opportunities WHERE is_active = 1').get()
        console.info(`[startup] Seeded ${newCount.count} funding opportunities`)
      } catch (e) {
        console.warn('[startup] Failed to auto-seed funding opportunities:', e?.message || e)
      }
    } else {
      console.info(`[startup] Found ${oppCount.count} existing funding opportunities`);
    }
  } catch (error) {
    console.warn('[startup] Error checking opportunities count:', error.message);
  }
} else {
  console.info('[startup] Skipping SQLite-only opportunity seeding checks (dialect != sqlite)')
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
  // This helper is SQLite-only today (PRAGMA usage + sync calls). Skip on Postgres until refactored.
  if (db.dialect !== 'sqlite') {
    console.info('[startup]', JSON.stringify({ event: 'min_national_ensure', enabled_by: 'skipped_postgres', minimum: min, skipped: true }))
  } else {
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
      const ensured = await ensureMinimumNationalOpportunities(db, min)
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
  }
} catch (error) {
  console.warn('[startup] Failed to ensure national minimum opportunities:', error?.message || error)
}

// Ensure curated assistance directories are available even when the DB already has many county_crawler records.
// This increases "real & relevant" coverage for special needs / emergency assistance matching without fabricating data.
try {
  // This helper is SQLite-only today (sync calls + local JSON files). Skip on Postgres until refactored.
  if (db.dialect !== 'sqlite') {
    console.info('[startup] Skipping assistance directory seeding (dialect != sqlite)')
  } else {
    const existing = db
      .prepare("SELECT COUNT(*) as count FROM funding_opportunities WHERE source IN ('state_211','assistance_network')")
      .get()?.count
    if ((existing ?? 0) < 250) {
      console.info('[startup] Seeding assistance directories (state_211 + assistance_network)...')
      const dataDir = join(__dirname, 'data')
      const hasAssistanceSeedFiles =
        fs.existsSync(join(dataDir, 'state_assistance_programs.json')) ||
        fs.existsSync(join(dataDir, 'local_assistance_networks.json'))

      if (!hasAssistanceSeedFiles) {
        console.info(
          `[startup] Assistance directory seed files missing under ${dataDir}; skipping`,
        )
      } else {
        const result = await seedAssistanceDirectories(db)
        const after = db
          .prepare("SELECT COUNT(*) as count FROM funding_opportunities WHERE source IN ('state_211','assistance_network')")
          .get()?.count
        console.info('[startup] Seeded assistance directories', { ...result, after })
      }
    } else {
      console.info('[startup] Assistance directories already seeded', { count: existing })
    }
  }
} catch (error) {
  console.warn('[startup] Failed to seed assistance directories:', error?.message || error)
}

function resolveJwtSecret() {
  const raw = String(process.env.AUTH_JWT_SECRET || process.env.JWT_SECRET || '').trim();
  const isProd = process.env.NODE_ENV === 'production';

  if (!raw) {
    if (isProd) {
      // NOTE: Railway outages are worse than a temporary auth secret.
      // We still emit a loud error so the operator sets a real secret ASAP.
      const generated = crypto.randomBytes(48).toString('base64url')
      console.error(
        'ERROR: Missing AUTH_JWT_SECRET (or JWT_SECRET). Using an EPHEMERAL secret to avoid startup crash.\n' +
          'Set a strong random secret (recommended: 32+ bytes) and redeploy to avoid logouts on restart.\n' +
          '  AUTH_JWT_SECRET="..."\n',
      );
      return generated
    }
    console.warn('[startup] AUTH_JWT_SECRET not set; using insecure development default (DO NOT use in production).');
    return 'grantflow-dev-secret';
  }

  if (isProd && raw === 'grantflow-dev-secret') {
    const generated = crypto.randomBytes(48).toString('base64url')
    console.error(
      'ERROR: AUTH_JWT_SECRET is set to the insecure development default. Using an EPHEMERAL secret to avoid startup crash.\n' +
        'Generate a strong random secret and redeploy.',
    );
    return generated
  }

  return raw;
}

const EFFECTIVE_JWT_SECRET = resolveJwtSecret();
const isProd = process.env.NODE_ENV === 'production'

// Make db available to routes
app.use((req, res, next) => {
  req.db = db;
  next();
});

app.use(async (req, res, next) => {
  const authHeader = req.headers.authorization || '';
  const xAdminToken = req.headers['x-admin-token'];
  const xAnyaToken = req.headers['x-anya-token'];
  let user = { role: 'guest', profileId: null };
  let handled = false;

  // 1. Check X-Admin-Token
  const expectedAdminToken = ADMIN_TOKEN;
  const expectedBulkKey = process.env.BULK_POPULATE_KEY || null;
  if (
    !handled &&
    xAdminToken &&
    ((expectedAdminToken && xAdminToken === expectedAdminToken) ||
      (expectedBulkKey && xAdminToken === expectedBulkKey))
  ) {
    user = {
      role: 'admin',
      is_admin: true,
      profileId: null,
      full_name: ADMIN_NAME,
      email: ADMIN_EMAIL,
    };
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
        const payload = jwt.verify(token, EFFECTIVE_JWT_SECRET);
        // Stateless JWT acceptance (important for multi-instance deployments where SQLite session storage
        // is not shared across instances). If the token is correctly signed and unexpired, trust its claims.
        // We still try to validate against DB sessions when available, but we do not require it.
        if (payload && typeof payload === 'object') {
          const roles = Array.isArray(payload.roles) ? payload.roles : [];
          const isAdmin = roles.includes('admin');
          if (payload.sub) {
            user = {
              role: isAdmin ? 'admin' : 'user',
              is_admin: isAdmin,
              userId: payload.sub,
              profileId: payload.profile_id ?? null,
              sessionId: payload.sid ?? null,
              full_name: payload.name ?? null,
              email: payload.email ?? null,
              roles,
            };
            handled = true;
          }
        }

        // Best-effort DB session validation/enrichment (when sessions are stored locally).
        if (payload?.sid) {
          const sessionRow = await db
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
      user = {
        role: 'admin',
        is_admin: true,
        profileId: null,
        full_name: ADMIN_NAME,
        email: ADMIN_EMAIL,
      };
      handled = true;
    }

    // Legacy "profile-id bearer token" is unsafe; allow only in non-prod with explicit opt-in.
    const allowLegacyProfileToken =
      isProd === false && String(process.env.ALLOW_LEGACY_PROFILE_TOKEN || '').trim().toLowerCase() === 'true'

    if (!handled && token && allowLegacyProfileToken) {
      try {
        const profile = await db
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

// Ensure synthetic admin-token users exist so foreign keys don't explode.
// This keeps admin-token flows (Anya, etc.) stable even on fresh DBs.
app.use(async (req, _res, next) => {
  const user = req.user
  if (!user || user.role !== 'admin' || !user.userId) return next()

  try {
    const existing = await db
      .prepare(
        `
          SELECT id
          FROM users
          WHERE id = ?
          LIMIT 1
        `,
      )
      .get(user.userId)

    if (!existing?.id) {
      await db
        .prepare(
          `
            INSERT INTO users (id, display_name, primary_email, is_admin)
            VALUES (?, ?, ?, 1)
          `,
        )
        .run(
          user.userId,
          user.full_name || ADMIN_NAME || 'Admin User',
          user.email || ADMIN_EMAIL || null,
        )
    }
  } catch {
    // Best-effort only: do not block requests if the users table is unavailable.
  }

  return next()
})

// Health check with dependency checks
// Health check endpoint (v3.0 - complete county data)
app.get('/health', async (req, res) => {
  const health = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    dependencies: {
      database: 'unknown',
      openai: 'unknown',
      anthropic: 'unknown',
    }
  };
  
  // Check database connection
  try {
    if (db.healthcheck) {
      const hc = await db.healthcheck();
      if (!hc?.ok) throw new Error(hc?.error || 'Database healthcheck failed')
    } else {
      await db.prepare('SELECT 1').get();
    }
    health.dependencies.database = 'healthy';
  } catch (error) {
    health.dependencies.database = 'unhealthy';
    health.status = 'degraded';
  }
  
  // Check if OpenAI API key is configured
  const hasOpenAIKey = Boolean(String(process.env.OPENAI_API_KEY || '').trim())
  const hasAnthropicKey = Boolean(String(process.env.ANTHROPIC_API_KEY || '').trim())
  health.dependencies.openai = hasOpenAIKey
    ? 'configured'
    : hasAnthropicKey
      ? 'fallback_anthropic_configured'
      : 'not configured';
  
  const statusCode = health.status === 'healthy' ? 200 : 503;
  res.status(statusCode).json(health);
});

// Authentication diagnostics endpoint
app.get('/api/auth/diagnostics', async (req, res) => {
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
    if (db.healthcheck) {
      const hc = await db.healthcheck();
      if (!hc?.ok) throw new Error(hc?.error || 'Database healthcheck failed')
    } else {
      await db.prepare('SELECT COUNT(*) as count FROM users').get();
    }
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

app.get('/api/auth/me', authMeLimiter, async (req, res) => {
  try {
    const user = req.user ?? { role: 'guest' };
    if (user.role === 'guest') {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    if (user.userId) {
      let dbUser, profiles;
      
      try {
        dbUser = await req.db
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
        // Dev/admin token convenience: ADMIN_TOKEN can authenticate an admin user without a stored user record.
        // Create the user record on-demand so the frontend auth bootstrap (`/api/auth/me`) is not brittle.
        if (user.role === 'admin' || user.is_admin === true) {
          try {
            db.prepare(
              `
                INSERT INTO users (id, display_name, primary_email, is_admin)
                VALUES (?, ?, ?, 1)
              `,
            ).run(
              user.userId,
              user.full_name || ADMIN_NAME || 'Admin User',
              user.email || ADMIN_EMAIL || null,
            )

            dbUser = db
              .prepare(
                `
                  SELECT *
                  FROM users
                  WHERE id = ?
                `,
              )
              .get(user.userId)
          } catch (repairError) {
            console.warn('[/api/auth/me] Unable to self-heal missing admin user:', repairError?.message || repairError)
          }
        }

        if (!dbUser) {
          return res.status(401).json({ error: 'User record not found' });
        }
      }

      try {
        profiles = await req.db
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
        profiles: Array.isArray(profiles) ? profiles : [],
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
app.use('/api/matching', matchingRouter);
app.use('/api/grant-monitoring', grantMonitoringRouter);
app.use('/api/crawlers', crawlersRouter);
app.use('/api/real-crawlers', realCrawlersRouter);
app.use('/api/preferences', preferencesRouter);

function resolveBuildSha() {
  return (
    process.env.RAILWAY_GIT_COMMIT_SHA ||
    process.env.GIT_COMMIT_SHA ||
    process.env.COMMIT_SHA ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    null
  )
}

// Build metadata endpoint (public, no secrets)
app.get('/api/meta/build', (_req, res) => {
  res.json({
    sha: resolveBuildSha(),
    built_at:
      process.env.BUILD_TIMESTAMP ||
      process.env.RAILWAY_DEPLOYMENT_START_TIME ||
      null,
    node: process.version,
    env: process.env.NODE_ENV || 'development',
  })
})

// Public health endpoint - safe for non-admin users
app.get('/api/health', async (req, res) => {
  try {
    const healthSummary = await getSafeHealthSummary(db)
    // Contract: public health endpoints must use { ok, warning, error } for status.
    // Some internal helpers may return { healthy, degraded, unhealthy } — normalize here.
    const rawStatus = String(healthSummary?.status ?? 'error').toLowerCase()
    const status =
      rawStatus === 'healthy'
        ? 'ok'
        : rawStatus === 'degraded'
          ? 'warning'
          : rawStatus === 'unhealthy'
            ? 'error'
            : rawStatus || 'error'

    // Treat "warning" as healthy for platform checks (Railway healthchecks, Docker HEALTHCHECK, etc.)
    // Only fail hard when the normalized status indicates a real error.
    const statusCode = status === 'error' ? 500 : 200
    const body =
      rawStatus === status
        ? healthSummary
        : { ...healthSummary, status, legacy_status: rawStatus }

    res.status(statusCode).json(body)
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

// Platform health aliases (k8s-style)
app.get('/healthz', async (_req, res) => {
  try {
    const healthSummary = await getSafeHealthSummary(db)
    const rawStatus = healthSummary?.status ?? 'error'
    const status =
      rawStatus === 'healthy'
        ? 'ok'
        : rawStatus === 'degraded'
          ? 'warning'
          : rawStatus === 'unhealthy'
            ? 'error'
            : rawStatus

    const statusCode = status === 'error' ? 500 : 200
    const body =
      rawStatus === status
        ? healthSummary
        : { ...healthSummary, status, legacy_status: rawStatus }

    res.status(statusCode).json(body)
  } catch (error) {
    console.error('[/healthz] Error:', error);
    res.status(500).json({ status: 'error', summary: 'Failed to retrieve health information' });
  }
});

app.get('/readyz', async (_req, res) => {
  try {
    if (db.healthcheck) {
      const hc = await db.healthcheck();
      if (!hc?.ok) throw new Error(hc?.error || 'Database healthcheck failed')
    } else {
      await db.prepare('SELECT 1 as ok').get();
    }
    // Ensure uploads dir is present and writable (production requires a volume).
    try {
      fs.mkdirSync(uploadsDir, { recursive: true });
      fs.accessSync(uploadsDir, fs.constants.R_OK | fs.constants.W_OK);
    } catch (e) {
      return res.status(503).json({
        status: 'not_ready',
        reason: 'uploads_dir_unwritable',
        uploads_dir: uploadsDir,
        message: e?.message || String(e),
        timestamp: new Date().toISOString(),
      });
    }
    res.status(200).json({ status: 'ready', dialect: db.dialect, timestamp: new Date().toISOString() });
  } catch (error) {
    console.error('[/readyz] Not ready:', error);
    res.status(503).json({ status: 'not_ready', reason: 'database_unreachable', timestamp: new Date().toISOString() });
  }
});

app.use('/api/admin', adminRouter);
app.use('/api', discoveryRouter); // Discovery endpoints (comprehensiveMatch, searchOpportunities, etc.)
app.use('/api/crawler-v2', crawlerV2Router);
app.use('/api/nf-programs', nfProgramsRouter);

// Pipeline stats
app.get('/api/pipeline/stats', async (req, res) => {
  try {
    const rows = await db.prepare(`
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
      pipelineKeys[normalized] += Number(row.count ?? 0);
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
  
  server.close(async () => {
    console.log('HTTP server closed');
    
    try {
      const maybe = db?.close?.()
      if (maybe && typeof maybe.then === 'function') {
        await maybe
      }
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

const server = app.listen(PORT, '0.0.0.0');

server.on('error', (err) => {
  const code = err?.code || 'UNKNOWN';
  if (code === 'EADDRINUSE') {
    console.error('[Server] Failed to bind port ' + PORT + ': address already in use. Stop the other process or set PORT to a free port (e.g. PORT=0 for ephemeral).');
  } else {
    console.error('[Server] Failed to start HTTP server:', err);
  }
  process.exit(1);
});

server.on('listening', () => {
  const loggedCorsOrigins = Array.isArray(corsOptions.origin) ? corsOptions.origin : [corsOptions.origin];
  console.log(`CORS origins: ${loggedCorsOrigins.join(', ')}`);
  const actualPort = server.address()?.port ?? PORT;
  console.log('[Server] Ready on port', actualPort);
  
  // Initialize feature flags
  try {
    initializeFeatureFlags(db);
    console.log('[FeatureFlags] Initialized successfully');
  } catch (err) {
    console.warn('[FeatureFlags] Failed to initialize:', err.message);
  }
  
  // Log server startup event
  try {
    logAuditEvent(db, {
      category: AUDIT_CATEGORIES.SYSTEM,
      action: 'server_startup',
      severity: SEVERITY.INFO,
      details: {
        port: actualPort,
        environment: process.env.NODE_ENV || 'development',
        corsOrigins: loggedCorsOrigins,
      },
    });
  } catch (err) {
    // Non-critical - don't fail server startup
  }
  
  // Start Anya autonomous operations 5 seconds after server is ready.
  // Postgres migration rollout: disable autonomous startup until all DB call sites are async-safe and
  // boolean/int comparisons have been normalized for Postgres.
  if (process.env.ANYA_AUTONOMOUS_ENABLED === 'true' && db.dialect === 'sqlite') {
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
