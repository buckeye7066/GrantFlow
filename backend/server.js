// Load `.env` from the current working directory. Use override so `.env` wins over any stale
// machine-level OPENAI_API_KEY values during local development.
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import { db } from './db/index.js';

console.info('[server] Booting backend', {
  commit: process.env.RAILWAY_GIT_COMMIT_SHA || 'unknown',
  time: new Date().toISOString(),
});

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
import itemsRouter from './routes/items.js';
import profilesRouter from './routes/profiles.js';
import remindersRouter from './routes/reminders.js';
import crawlersRouter from './routes/crawlers.js';
import vehiclesRouter from './routes/vehicles.js';
import realCrawlersRouter from './routes/realCrawlers.js';
import matchingRouter from './routes/matching.js';
import grantMonitoringRouter from './routes/grantMonitoring.js';
import billingRouter from './routes/billing.js';
import authRouter from './routes/auth.js';
import preferencesRouter from './routes/preferences.js';
import incognitoRouter from './routes/incognito.js';
import adminRouter from './routes/admin.js';
import discoveryRouter from './routes/discovery.js';
import statsRouter from './routes/stats.js';
import healthRouter from './routes/health.js';
import crawlLogsRouter from './routes/crawlLogs.js'
import sourceDirectoryRouter from './routes/sourceDirectory.js'
import activityRouter from './routes/activity.js'
import budgetsRouter from './routes/budgets.js'
import contactsRouter from './routes/contacts.js'
import applicationDraftsRouter from './routes/applicationDrafts.js'
import applicationsRouter from './routes/applications.js'
import billingSettingsRouter from './routes/billingSettings.js'
import contactMethodsRouter from './routes/contactMethods.js'
import outreachLogsRouter from './routes/outreachLogs.js'
import versionRouter from './routes/version.js'
import ensureDesignatedProfiles from './utils/ensureDesignatedProfiles.js';
import ensureUserPreferencesTable from './utils/ensureUserPreferencesTable.js';
import ensurePortalCheckResultsTable from './utils/ensurePortalCheckResultsTable.js';
import { linkAllProfilesToAdmin } from './utils/adminProfileLinks.js';
import { ensureProfileOrgLinks } from './utils/ensureProfileOrgLinks.js'
import ensureMinimumNationalOpportunities from './utils/ensureMinimumNationalOpportunities.js';
import seedAssistanceDirectories from './utils/seedAssistanceDirectories.js';
import seedFaithBasedHousing from './utils/seedFaithBasedHousing.js';
import { errorHandler } from './middleware/errorHandler.js';
import { attachRequestContext } from './middleware/requestContext.js';
import { createAuthIdentityMiddleware } from './middleware/authIdentity.js';
import { createEnsureAdminUserMiddleware } from './middleware/ensureAdminUser.js';
import { createAuthMeRouter } from './routes/authMe.js';
import { pipelineMonitor, getPipelineHealth } from './middleware/pipelineMonitor.js';
import { ensureAuth } from './middleware/auth.js';
import { requestTimeout } from './middleware/requestTimeout.js';
import { responseCache } from './middleware/responseCache.js';
import { MAX_JSON_BODY_SIZE } from './config/constants.js';
import { getSafeHealthSummary } from './services/diagnosticsService.js';
import { assertFundingApiKeys, getFundingApiKeyPresence } from './src/config/apiKeys.js';
import { dispatchCrawlerJob, startQueueDrainInterval } from './services/crawlerDispatcher.js';
import { cleanupStaleCrawlers, cleanupStaleQueuedJobs } from './services/crawlerConcurrencyGuard.js'
import { findDuplicateProfileGroups, mergeProfiles } from './services/profileDedupeService.js'
import { assertEnv, getJwtSecretOrThrow } from './config/env.js'
import { resolveUploadsDir, ensureUploadsDirWritable, isLikelyPersistentPath } from './utils/uploadsDir.js'
import servicesRouter from './routes/services.js'
import stripeRouter from './routes/stripe.js'
import stripeWebhookRouter from './routes/stripeWebhook.js'
import adminServiceCatalogRouter from './routes/adminServiceCatalog.js'
import collegesRouter from './routes/colleges.js'
// Startup phase modules
import { runBootstrap } from './startup/bootstrap.js';
import { runSelfHeal } from './startup/selfHeal.js';
import { runQueueRecovery } from './startup/queueRecovery.js';
import { startBackgroundServices } from './startup/backgroundServices.js';

/**
 * Lazy-loading route helper — caches the imported router after first load.
 * Routes that are called infrequently (e.g., admin crawlers, legacy functions)
 * are excluded from the eager import list to speed up server startup.
 *
 * @param {string} specifier - ESM specifier relative to this file (e.g., './routes/nofo.js')
 * @param {Function} [extract] - Optional: extract the router from the module (default: .default)
 * @returns {express.RequestHandler}
 */
function lazyRouter(specifier, extract) {
  let _router = null
  return async (req, res, next) => {
    if (!_router) {
      const mod = await import(specifier)
      _router = extract ? extract(mod) : (mod.default ?? mod)
    }
    _router(req, res, next)
  }
}

// Validate environment variables early (fail-fast in production).
const { env: ENV } = assertEnv()

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

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || process.env.ANYA_ADMIN_TOKEN || (() => {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('ADMIN_TOKEN is required in production');
  }
  return null;
})();
const ADMIN_NAME = process.env.ADMIN_NAME || 'Admin User';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@grantflow.app';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Uploads must live on a persistent volume in production (Railway Volume).
// Set UPLOADS_DIR=/data/uploads (or your mount path) in Railway.
// Default to backend/uploads for local/dev so routes and serving agree.
const { uploadsDir, legacyUploadsDir } = resolveUploadsDir({ baseDir: __dirname })
const distPath = join(__dirname, '..', 'dist');

const app = express();
app.set('trust proxy', 1);
app.set('etag', 'strong');
const PORT = ENV?.PORT ?? process.env.PORT ?? 8080;

// Security headers (must run early, before routes).
// Keep CSP behavior unchanged (some deployments may already set CSP at a proxy/CDN layer).
// Allow cross-origin resource loading (e.g., Vercel frontend loading /uploads from Railway API origin).
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
  }),
);

// CORS configuration
const defaultCorsOrigins = [
  'http://localhost:5173',
  'http://localhost:3000',
  'https://grant-flow-three.vercel.app',
  'https://app.axiombiolabs.org',
  'https://www.axiombiolabs.org',
  'https://grantflow-production.up.railway.app',
];
const configuredCorsOrigins = Array.isArray(ENV?.corsOrigins) && ENV.corsOrigins.length > 0 ? ENV.corsOrigins : [];
const effectiveCorsOrigins = Array.from(new Set([...defaultCorsOrigins, ...configuredCorsOrigins]));

function normalizeCorsOrigin(origin) {
  if (!origin || typeof origin !== 'string') return null;
  try {
    return new URL(origin).origin;
  } catch {
    return origin.replace(/\/$/, '');
  }
}

const allowedOriginSet = new Set(effectiveCorsOrigins.map((o) => normalizeCorsOrigin(o)).filter(Boolean));

function isOriginAllowed(requestOrigin) {
  if (!requestOrigin) return true; // same-origin / curl / non-browser
  const n = normalizeCorsOrigin(requestOrigin);
  if (!n) return false;
  if (allowedOriginSet.has(n)) return true;
  // Any HTTPS host under axiombiolabs.org (app, www, future subdomains)
  if (/^https:\/\/([a-z0-9-]+\.)*axiombiolabs\.org$/i.test(n)) return true;
  return false;
}

const corsOptions = {
  origin(origin, callback) {
    if (!origin) {
      callback(null, true);
      return;
    }
    if (isOriginAllowed(origin)) {
      callback(null, true);
      return;
    }
    console.warn('[cors] blocked Origin:', origin);
    callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Admin-Token',
    'X-Anya-Token',
    'X-Profile-Id',
    'X-Request-Id',
    'Accept',
    'Origin',
    'X-Requested-With',
    'Cache-Control',
    'Pragma',
  ],
  exposedHeaders: ['X-Request-Id'],
  maxAge: 86_400,
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

app.use(compression({ threshold: 1024 }));

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

// Stripe webhook MUST be mounted before JSON parser (raw body required).
// Ensure req.db is available to the webhook handler too.
app.use((req, res, next) => {
  req.db = db;
  req.uploadsDir = uploadsDir;
  req.legacyUploadsDir = legacyUploadsDir;
  req.storageStatus = app.locals.uploads?.storageStatus || null;
  next();
});

app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }), stripeWebhookRouter)

app.use(express.json({ limit: MAX_JSON_BODY_SIZE }));

// Mount health check routes EARLY to ensure they're always available
// req.db is already attached above.
app.use(healthRouter);

// IMPORTANT: Missing uploads must return 404 (not SPA index.html).
// Serve both current + legacy upload locations, then terminate with a strict 404.
// User-uploaded files use no-cache so updated files are always re-validated.
app.use('/uploads', express.static(uploadsDir, {
  index: false,
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-cache')
  },
}));
try {
  if (legacyUploadsDir !== uploadsDir && fs.existsSync(legacyUploadsDir)) {
    app.use('/uploads', express.static(legacyUploadsDir, {
      index: false,
      setHeaders(res) {
        res.setHeader('Cache-Control', 'no-cache')
      },
    }));
  }
} catch (error) {
  console.warn('[uploads] Legacy directory probe failed:', error?.message || error);
}
app.use('/uploads', (req, res) => {
  const reqPath = String(req.path || '').replace(/^\/+/, '')
  console.warn('[uploads] missing file', {
    requestId: req.requestId || null,
    path: reqPath || null,
    uploadsDir,
    legacyUploadsDir,
    referer: req.headers?.referer || null,
    ip: req.ip || null,
    userAgent: req.headers?.['user-agent'] || null,
    hasAuthHeader: Boolean(req.headers?.authorization),
  })
  const wantsJson = Boolean(req.accepts(['json']) && !req.accepts(['html']))
  if (wantsJson) {
    return res.status(404).json({
      ok: false,
      error: 'File not found',
      code: 'UPLOAD_MISSING',
      path: reqPath || null,
    })
  }
  return res.status(404).send('Not Found')
});

// Serve static files from Vite build
// Hashed asset files (JS/CSS with content hash in filename) get long-lived immutable cache.
// The SPA entry point (index.html) must not be cached so users always get the latest version.
app.use(express.static(distPath, {
  setHeaders(res, filePath) {
    if (filePath.includes('/assets/') && !filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    } else if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
    }
  },
}))
// Serve the SPA under the configured base path so production builds (base=/grantflow) work locally.
const APP_BASE_PATH = ENV?.appBase || process.env.AUTH_FRONTEND_APP_BASE || process.env.VITE_APP_BASE || '/grantflow';
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

// ── Phase 1: Boot-critical startup ────────────────────────────────────────────
// Handles: upload storage health, DB validation, schema migrations,
// runtime secrets restoration, crawler-jobs constraint rebuild, JWT resolution.
const { storageStatus, EFFECTIVE_JWT_SECRET } = await runBootstrap({
  db,
  uploadsDir,
  legacyUploadsDir,
  baseDir: __dirname,
});
app.locals.uploads = { uploadsDir, legacyUploadsDir, storageStatus };

// ── Smoke-mode detection ───────────────────────────────────────────────────────
// Many unit tests start the server with PORT=0 + DB_AUTO_MIGRATE=true but do not
// set SMOKE_MODE explicitly. Infer smoke mode so heavy startup tasks never block
// the "Ready" signal.
const explicitSmoke = String(process.env.SMOKE_MODE || '').trim().toLowerCase() === 'true';
const inferredSmoke =
  String(PORT) === '0' &&
  String(process.env.DB_AUTO_MIGRATE || '').trim().toLowerCase() === 'true' &&
  String(process.env.NODE_ENV || '').trim().toLowerCase() !== 'production';
const IS_SMOKE_MODE = explicitSmoke || inferredSmoke;

// ── Phase 2: Self-heal + baseline seeding ─────────────────────────────────────
// Handles: upload-avatar repair, document-status repair, baseline seed, service
// catalog, opportunity seeding, national minimums, assistance directories,
// faith-based housing.
let _selfHealStarted = false
async function runSelfHealOnce() {
  if (_selfHealStarted) return
  _selfHealStarted = true
  try {
    await runSelfHeal({ db, uploadsDir, IS_SMOKE_MODE, baseDir: __dirname })
    console.info('[startup] self-heal completed')
  } catch (error) {
    console.error('[startup] self-heal failed (continuing):', error?.message || error)
  }
}
if (process.env.NODE_ENV === 'test') {
  await runSelfHealOnce()
}

const isProd = process.env.NODE_ENV === 'production'

app.use(createAuthIdentityMiddleware({
  adminToken: ADMIN_TOKEN,
  adminName: ADMIN_NAME,
  adminEmail: ADMIN_EMAIL,
  jwtSecret: EFFECTIVE_JWT_SECRET,
  db,
  isProd,
}))

// Ensure synthetic admin-token users exist so foreign keys don't explode.
// This keeps admin-token flows (Anya, etc.) stable even on fresh DBs.
app.use(createEnsureAdminUserMiddleware({ db, adminName: ADMIN_NAME, adminEmail: ADMIN_EMAIL }))

// Attach canonical request context (MUST run after auth middleware)
// This provides req.ctx with userId, email, isAdmin (DB-backed), accessible profiles/orgs
app.use(attachRequestContext())

// Health check with dependency checks
// Health check endpoint (v3.0 - complete county data)

// Authentication /me and /diagnostics endpoints (extracted from server.js for testability)
app.use('/api/auth', createAuthMeRouter({ db, adminName: ADMIN_NAME, adminEmail: ADMIN_EMAIL }))

// Pipeline monitoring (zero-result + slow-response tracking)
app.use(pipelineMonitor())

// Pipeline health dashboard (admin-only)
app.get('/api/admin/pipeline-health', (req, res) => {
  res.json(getPipelineHealth())
})

// API routes
app.use('/api/auth', authRouter);
app.use('/api/activity', activityRouter);
app.use('/api/service-application', lazyRouter('./routes/serviceApplication.js'));
app.use('/api/billing', billingRouter);
app.use('/api/stats', responseCache(60_000), statsRouter);
app.use('/api/services', servicesRouter);
app.use('/api/stripe', stripeRouter);
app.use('/api/admin/service-catalog', adminServiceCatalogRouter)
app.use('/api/organizations', organizationsRouter);
app.use('/api/grants', grantsRouter);
app.use('/api/opportunities', opportunitiesRouter);
app.use('/api/programs', programsRouter);
app.use('/api/milestones', milestonesRouter);
app.use('/api/documents', documentsRouter);
app.use('/api/expenses', expensesRouter);
app.use('/api/budgets', budgetsRouter);
app.use('/api/contacts', contactsRouter);
app.use('/api/outreach-logs', outreachLogsRouter);
app.use('/api/application-drafts', applicationDraftsRouter);
app.use('/api/applications', applicationsRouter);
app.use('/api/vnext/applications', lazyRouter('./routes/vnextApplications.js'));
app.use('/api/billing-settings', billingSettingsRouter);
app.use('/api/contact-methods', contactMethodsRouter);
app.use('/api/source-directory', sourceDirectoryRouter);
app.use('/api/items', itemsRouter);
const PIPELINE_TIMEOUT = Number(process.env.PIPELINE_TIMEOUT_MS || 30000)
app.use('/api/ai', requestTimeout(PIPELINE_TIMEOUT), aiRouter);
app.use('/api/anya', anyaRouter);
app.use('/api/profiles', profilesRouter);
app.use('/api/reminders', remindersRouter);
app.use('/api/matching', requestTimeout(PIPELINE_TIMEOUT), matchingRouter);
app.use('/api/grant-monitoring', grantMonitoringRouter);
app.use('/api/crawlers', responseCache(30_000), crawlersRouter);
app.use('/api/real-crawlers', realCrawlersRouter);
app.use('/api/vehicles', vehiclesRouter);
app.use('/api/preferences', preferencesRouter);
// Incognito module endpoints (gated by user custom preferences)
app.use('/api/incognito', incognitoRouter);
app.use('/api/version', versionRouter);
// Function-style endpoints (used by NOFO Parser + Diagnostics)
app.use('/api', lazyRouter('./routes/nofo.js'));
// Legacy function-style endpoints (legacy UI flows: DataSources/SourceDirectory)
app.use('/api', lazyRouter('./routes/legacyFunctions.js'));
// Legacy entity endpoints
app.use('/api/crawl-logs', crawlLogsRouter);
// Geo Crawl monitor + start endpoints (admin-only)
app.use('/api/geo-crawl', lazyRouter('./routes/geoCrawl.js', (mod) => mod.default({ uploadDir: uploadsDir, getOpenAI: null })));
app.use('/api/colleges', collegesRouter);

// ── Build metadata endpoint (public, no secrets) ──────────────────────────────
// NOTE: This endpoint is used to confirm production is on the expected commit.
function _resolveBuildSha() {
  return (
    process.env.RAILWAY_GIT_COMMIT_SHA ||
    process.env.GIT_COMMIT_SHA ||
    process.env.COMMIT_SHA ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    null
  )
}

app.get('/api/meta/build', (_req, res) => {
  res.json({
    sha: _resolveBuildSha(),
    built_at:
      process.env.BUILD_TIMESTAMP ||
      process.env.RAILWAY_DEPLOYMENT_START_TIME ||
      null,
    node: process.version,
    env: process.env.NODE_ENV || 'development',
  })
})

// Public (safe) status for auto profile de-dupe runs.
// Does not expose profile names, IDs, or any secrets.
app.get('/api/meta/dedupe', async (_req, res) => {
  try {
    const row = await db
      .prepare(
        `
          SELECT created_at, details
          FROM audit_logs
          WHERE category = 'admin'
            AND action = 'auto_profile_dedupe'
          ORDER BY created_at DESC
          LIMIT 1
        `,
      )
      .get()

    if (!row) {
      return res.json({ ok: true, last_run: null })
    }

    const details =
      db?.dialect === 'postgres'
        ? row.details
        : (() => {
            try {
              return row.details ? JSON.parse(row.details) : null
            } catch {
              return null
            }
          })()

    return res.json({
      ok: true,
      last_run: {
        created_at: row.created_at ?? null,
        merged_groups: details?.merged_groups ?? null,
        merged_losers: details?.merged_losers ?? null,
        skipped_groups: details?.skipped_groups ?? null,
        sha: details?.sha ? String(details.sha).slice(0, 12) : null,
      },
    })
  } catch (error) {
    return res.json({ ok: false, error: error?.message || String(error) })
  }
})

app.use('/api/admin', adminRouter);
app.use('/api', requestTimeout(PIPELINE_TIMEOUT), discoveryRouter);
app.use('/api/crawler-v2', lazyRouter('./routes/crawlerV2.js'));
app.use('/api/nf-programs', lazyRouter('./routes/nfPrograms.js'));

// Pipeline stats
app.get('/api/pipeline/stats', ensureAuth, async (req, res) => {
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

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Graceful shutdown handling
let server = null

function gracefulShutdown(signal) {
  if (!server) return
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

if (process.env.NODE_ENV !== 'test') {
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  server = app.listen(PORT, '0.0.0.0');

  server.on('error', (err) => {
    const code = err?.code || 'UNKNOWN';
    if (code === 'EADDRINUSE') {
      console.error(
        '[Server] Failed to bind port ' +
          PORT +
          ': address already in use. Stop the other process or set PORT to a free port (e.g. PORT=0 for ephemeral).',
      );
    } else {
      console.error('[Server] Failed to start HTTP server:', err);
    }
    process.exit(1);
  });

  server.on('listening', () => {
    console.log(`CORS allowlist + axiombiolabs.org: ${effectiveCorsOrigins.join(', ')}`);
    const actualPort = server.address()?.port ?? PORT;
    console.log('[Server] Ready on port', actualPort);

    // Run heavy startup healing only after the server is reachable.
    // This prevents cold-start 502 windows from being reported as "CORS blocked".
    void runSelfHealOnce()

    // ── Phase 3: Queue recovery ───────────────────────────────────────────────
    runQueueRecovery({ db, uploadsDir });

    // Reset jobs stuck in 'running' from a previous process crash/restart (no persistent worker).
    (async () => {
      try {
        if (db.dialect === 'postgres') {
          const r = await db.prepare(`
            UPDATE crawler_jobs
            SET status = 'failed', error = 'Auto-reset: stuck after server restart', completed_at = NOW()
            WHERE status = 'running' AND started_at < (NOW() - INTERVAL '30 minutes')
          `).run();
          if (r?.changes > 0) console.log(`[startup] Reset ${r.changes} stuck crawler job(s)`);
        } else {
          const r = db.prepare(`
            UPDATE crawler_jobs
            SET status = 'failed', error = 'Auto-reset: stuck after server restart', completed_at = datetime('now')
            WHERE status = 'running' AND started_at < datetime('now', '-30 minutes')
          `).run();
          if (r?.changes > 0) console.log(`[startup] Reset ${r.changes} stuck crawler job(s)`);
        }
      } catch (err) {
        console.error('[startup] Failed to reset stuck jobs:', err?.message || err);
      }
    })();

    // Re-queue jobs that previously failed due to concurrency exhaustion on startup stampede.
    // These are recoverable — reset them so the staggered drain below can pick them up.
    ;(async () => {
      try {
        const r = await db.prepare(`
            UPDATE crawler_jobs
            SET status = 'queued',
                error = NULL,
                dispatch_attempts = 0,
                next_dispatch_at = NULL,
                completed_at = NULL
            WHERE status = 'failed'
              AND error = 'Crawler dispatch exhausted due to concurrency limits'
          `).run()
        const count = Number(r?.changes ?? r?.rowCount ?? 0)
        if (count > 0) {
          console.log(`[startup] Re-queued ${count} concurrency-exhausted job(s) for retry`)
        }
      } catch (err) {
        console.error('[startup] Failed to re-queue exhausted jobs:', err?.message || err)
      }
    })();

    // One-time cleanup on startup to recover orphaned crawler jobs from crashes/restarts.
    ;(async () => {
      try {
        const cleaned = await cleanupStaleCrawlers(db)
        if (cleaned > 0) {
          console.log(`[startup] Cleaned ${cleaned} stale crawler job(s) from previous run`)
        }
        const cleanedQueued = await cleanupStaleQueuedJobs(db)
        if (cleanedQueued > 0) {
          console.log(`[startup] Cleaned ${cleanedQueued} stale queued job(s) from previous run`)
        }
      } catch (err) {
        console.warn('[startup] Stale crawler cleanup failed:', err?.message)
      }
    })()

    // Background queue poller: pick up orphaned 'queued' jobs that were never dispatched.
    const QUEUE_POLL_INTERVAL_MS = Number.parseInt(process.env.QUEUE_POLL_INTERVAL_MS || '60000', 10)
    const queuePollEnabled = String(process.env.QUEUE_POLL_ENABLED ?? 'true').toLowerCase() !== 'false'

    // Gradually dispatch queued jobs on startup to avoid a stampede that exhausts concurrency.
    async function drainQueuedJobsGradually(dbRef, uploadsDirRef) {
      const STARTUP_DELAY_MS = Number.parseInt(process.env.QUEUE_STARTUP_DELAY_MS || '15000', 10)
      const STAGGER_DELAY_MS = Number.parseInt(process.env.QUEUE_STAGGER_DELAY_MS || '3000', 10)
      const INITIAL_BATCH = 2

      await new Promise((r) => setTimeout(r, STARTUP_DELAY_MS))

      let queued
      try {
        queued = await dbRef.prepare(`
          SELECT id FROM crawler_jobs
          WHERE status = 'queued'
          ORDER BY created_at ASC
          LIMIT ?
        `).all(INITIAL_BATCH)
      } catch (err) {
        console.warn('[startup-drain] Failed to query queued jobs:', err?.message)
        return
      }

      if (!Array.isArray(queued) || queued.length === 0) return

      console.log(`[startup-drain] Dispatching ${queued.length} queued job(s) with ${STAGGER_DELAY_MS}ms stagger`)
      for (let i = 0; i < queued.length; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, STAGGER_DELAY_MS))
        try {
          dispatchCrawlerJob({ db: dbRef, jobId: queued[i].id, uploadDir: uploadsDirRef, getOpenAI: null }).catch(e => console.warn('[background]', e?.message || e))
        } catch { /* ignore individual dispatch errors */ }
      }
    }

    if (queuePollEnabled) {
      // Run a staggered startup drain before the regular poller begins.
      drainQueuedJobsGradually(db, uploadsDir).catch((err) => {
        console.warn('[startup-drain] Staggered drain failed:', err?.message)
      })

      const queuePollHandle = setInterval(async () => {
        try {
          // Clean up stale running jobs before attempting to dispatch
          try {
            await cleanupStaleCrawlers(db)
          } catch (err) {
            console.warn('[queue-poller] Stale crawler cleanup failed (ignored):', err?.message)
          }

          // Clean up queued jobs that have been waiting longer than 24 hours
          try {
            const cleanedQueued = await cleanupStaleQueuedJobs(db)
            if (cleanedQueued > 0) {
              console.warn(`[queue-poller] Cleaned ${cleanedQueued} stale queued job(s)`)
            }
          } catch (err) {
            console.warn('[queue-poller] Stale queued job cleanup failed (ignored):', err?.message)
          }

          const queued = await db.prepare(`
            SELECT id FROM crawler_jobs
            WHERE status = 'queued'
            ORDER BY created_at ASC
            LIMIT 3
          `).all()
          if (!Array.isArray(queued) || queued.length === 0) return

          for (const job of queued) {
            try {
              dispatchCrawlerJob({ db, jobId: job.id, uploadDir: uploadsDir, getOpenAI: null }).catch(e => console.warn('[background]', e?.message || e))
            } catch { /* ignore individual dispatch errors */ }
          }
          if (queued.length > 0) {
            console.log(`[queue-poller] Dispatched ${queued.length} orphaned queued job(s)`)
          }
        } catch (err) {
          console.error('[queue-poller] Poll error:', err?.message || err)
        }
      }, QUEUE_POLL_INTERVAL_MS)

      process.once('SIGTERM', () => clearInterval(queuePollHandle))
      process.once('SIGINT', () => clearInterval(queuePollHandle))
      console.log(`[startup] Background queue poller enabled (every ${QUEUE_POLL_INTERVAL_MS / 1000}s)`)

      // Periodic queue-drain interval: recovers jobs orphaned by process restarts
      // (their in-process setTimeout timers are lost; this picks them back up).
      const drainIntervalHandle = startQueueDrainInterval(db, uploadsDir, null)
      process.once('SIGTERM', () => clearInterval(drainIntervalHandle))
      process.once('SIGINT', () => clearInterval(drainIntervalHandle))
    } else {
      console.log('[startup] Background queue poller disabled (set QUEUE_POLL_ENABLED=true to enable)')
    }

    // ── Phase 4: Background services ──────────────────────────────────────────
    // All startup tasks (pipeline self-check, feature flags, smoke crawlers,
    // auto-dedupe, audit log, Anya scheduler, CodeGuard audit, national
    // programs) are handled by the single canonical entry point.
    startBackgroundServices({ db, uploadsDir, actualPort, loggedCorsOrigins: effectiveCorsOrigins });
  });
} else {
  console.info('[server] NODE_ENV=test; HTTP listener disabled')
}

export default app;
