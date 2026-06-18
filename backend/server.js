// Load `.env` from the current working directory. Use override so `.env` wins over any stale
// machine-level OPENAI_API_KEY values during local development.
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { createLogger, setAuditLogSink } from './utils/logger.js';

const serverLogger = createLogger('server');
import fs from 'fs';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import { safeTokenEqual } from './utils/safeTokenEqual.js';
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
import anyaMatchSuggestionsRouter from './routes/anyaMatchSuggestions.js';
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
import jwt from 'jsonwebtoken';
import healthRouter from './routes/health.js';
import crawlLogsRouter from './routes/crawlLogs.js'
import sourceDirectoryRouter from './routes/sourceDirectory.js'
import activityRouter from './routes/activity.js'
import budgetsRouter from './routes/budgets.js'
import contactsRouter from './routes/contacts.js'
import applicationDraftsRouter from './routes/applicationDrafts.js'
import applicationsRouter from './routes/applications.js'
import grantApplicationsRouter from './routes/grantApplications.js'
import applicationWorkflowRouter from './routes/applicationWorkflow.js'
import billingSettingsRouter from './routes/billingSettings.js'
import contactMethodsRouter from './routes/contactMethods.js'
import outreachLogsRouter from './routes/outreachLogs.js'
import versionRouter from './routes/version.js'
import ensureDesignatedProfiles from './utils/ensureDesignatedProfiles.js';
import ensureUserPreferencesTable from './utils/ensureUserPreferencesTable.js';
import { linkAllProfilesToAdmin } from './utils/adminProfileLinks.js';
import { ensureProfileOrgLinks } from './utils/ensureProfileOrgLinks.js'
import { runStartupOperations } from './services/anyaStartupOperations.js';
import { startHealthService } from './services/anyaHealthService.js';
import ensureMinimumNationalOpportunities from './utils/ensureMinimumNationalOpportunities.js';
import seedAssistanceDirectories from './utils/seedAssistanceDirectories.js';
import seedFaithBasedHousing from './utils/seedFaithBasedHousing.js';
import seedHousingFundingOpportunities from './utils/seedHousingFunding.js';
import { errorHandler } from './middleware/errorHandler.js';
import { profileContextMiddleware } from './middleware/profileContext.js';
import { attachRequestContext } from './middleware/requestContext.js';
import { pipelineMonitor, getPipelineHealth } from './middleware/pipelineMonitor.js';
import { requestTimeout } from './middleware/requestTimeout.js';
import { responseCache } from './middleware/responseCache.js';
import { MAX_JSON_BODY_SIZE, GRANT_STATUSES } from './config/constants.js';
import { getSafeHealthSummary } from './services/diagnosticsService.js';
import { initializeFeatureFlags } from './services/featureFlagService.js';
import { logAuditEvent, AUDIT_CATEGORIES, SEVERITY } from './services/auditService.js';
import { decryptRuntimeSecret } from './utils/runtimeSecrets.js';
import { seedBaselineFromRepo } from './utils/seedBaselineFromRepo.js';
import { assertFundingApiKeys, getFundingApiKeyPresence } from './src/config/apiKeys.js';
import { ensureProfileEmailSchema } from './utils/accessControl.js';
import { dispatchCrawlerJob, startQueueDrainInterval } from './services/crawlerDispatcher.js';
import { cleanupStaleCrawlers, cleanupStaleQueuedJobs } from './services/crawlerConcurrencyGuard.js'
import { findDuplicateProfileGroups, mergeProfiles } from './services/profileDedupeService.js'
import { assertEnv, getJwtSecretOrThrow } from './config/env.js'
import { resolveUploadsDir, ensureUploadsDirWritable, isLikelyPersistentPath } from './utils/uploadsDir.js'
import servicesRouter from './routes/services.js'
import stripeRouter from './routes/stripe.js'
import stripeWebhookRouter from './routes/stripeWebhook.js'
import { seedServiceCatalogFromExtract } from './services/serviceCatalogStore.js'
import adminServiceCatalogRouter from './routes/adminServiceCatalog.js'
import adminQueueOpsRouter from './routes/adminQueueOps.js'
import collegesRouter from './routes/colleges.js'
import { allowedOriginCheckSQL } from './utils/recordOrigins.js'
import notificationsRouter from './routes/notifications.js'
import savedGrantsRouter from './routes/savedGrants.js'
import foundationsRouter from './routes/foundations.js'
import { expirePassedDeadlines } from './services/deadlineExpiryService.js'
import { generateDeadlineNotifications } from './services/deadlineNotificationService.js'
import { runLinkVerification } from './services/linkVerificationService.js'
import { validateCriticalImports } from './startup/validateImports.js'

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

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || process.env.ANYA_ADMIN_TOKEN || null;
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

// --------------------------------------------------------------------------
// Base-path API rewrite (Vercel parity for non-Vercel environments)
//
// Production frontend is served by Vercel under /grantflow/* and Vercel
// rewrites `/grantflow/api/:path*` → `https://grantflow-production.up.railway.app/api/:path*`
// (see vercel.json). The Vite build also bakes the appBase prefix into
// every API call (see src/config/env.js → getApiBasePrefixForFetch()), so
// the SPA emits requests like `/grantflow/api/auth/me`.
//
// In smoke / Railway / local dev there is no CDN doing that rewrite, and
// without one the static SPA fallback at `app.use(APP_BASE_PATH, express.static)`
// answers `/grantflow/api/auth/me` with the SPA's index.html. The frontend
// then tries to JSON.parse HTML, the auth bootstrap silently fails, and
// admin-only quick actions stay greyed out (Anya goals 4, 6, 8) — exactly
// the failure mode the admin-tools-button-live smoke test surfaced.
//
// The fix is a thin URL rewriter that strips the configured app base off
// any `/<base>/api/*` or `/<base>/uploads/*` request before route matching.
// It is a no-op when the app base is `/`.
const __appBasePathRaw =
  ENV?.appBase || process.env.AUTH_FRONTEND_APP_BASE || process.env.VITE_APP_BASE || '/';
const __appBasePathNormalized = String(__appBasePathRaw).replace(/\/+$/, '');
if (__appBasePathNormalized && __appBasePathNormalized !== '') {
  const stripPrefix = __appBasePathNormalized; // e.g. '/grantflow'
  const stripPattern = new RegExp(
    `^${stripPrefix.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}(/api(?:/|$)|/uploads(?:/|$))`,
  );
  app.use((req, _res, next) => {
    if (stripPattern.test(req.url)) {
      req.url = req.url.slice(stripPrefix.length);
      if (req.url === '' || req.url[0] !== '/') req.url = '/' + req.url;
    }
    next();
  });
}

// --- Upload storage health (single source of truth) ---
const isProdEnv = String(process.env.NODE_ENV || '').toLowerCase() === 'production'
const allowEphemeralUploads = String(process.env.ALLOW_EPHEMERAL_UPLOADS || '').toLowerCase() === 'true'
const isRailwayRuntime = Boolean(
  String(process.env.RAILWAY_ENVIRONMENT || '').trim() ||
    String(process.env.RAILWAY_PROJECT_ID || '').trim() ||
    String(process.env.RAILWAY_SERVICE_ID || '').trim(),
)

// ── Production reality gate (mission rule) ───────────────────────────────
// "Real funding only" is enforced at the process level instead of trusting
// every crawler to behave. The contract:
//
//   * In production, URL verification is DEFAULT-ON. If
//     URL_VERIFICATION_ENABLED is unset, we treat it as 'true' and propagate
//     it back to the env so every downstream consumer (opportunityInserter's
//     bulk verifier, schedulers, crawlers) sees it on without separate
//     configuration.
//
//   * The only way to boot production with verification disabled is to
//     EXPLICITLY set URL_VERIFICATION_ENABLED=false AND set
//     GRANTFLOW_SKIP_VERIFICATION_GATE=true. The combination forces the
//     operator to acknowledge that they are knowingly running a seed /
//     import / migration boot.
//
//   * Tests that spawn a "production-mode" server (auth flows, ephemeral
//     SQLite smoke tests) opt out via the well-known ALLOW_EPHEMERAL_SQLITE
//     flag so they don't need to learn about this gate.
const verificationEnvRaw = String(process.env.URL_VERIFICATION_ENABLED || '').toLowerCase()
const verificationExplicitlyDisabled = verificationEnvRaw === 'false' || verificationEnvRaw === '0' || verificationEnvRaw === 'no'
const verificationExplicitlyEnabled = verificationEnvRaw === 'true' || verificationEnvRaw === '1' || verificationEnvRaw === 'yes'
const skipVerificationGate =
  String(process.env.GRANTFLOW_SKIP_VERIFICATION_GATE || '').toLowerCase() === 'true' ||
  String(process.env.NODE_ENV || '').toLowerCase() === 'test' ||
  String(process.env.GRANTFLOW_SEED_MODE || '').toLowerCase() === 'true' ||
  String(process.env.ALLOW_EPHEMERAL_SQLITE || '').toLowerCase() === 'true'

if (isProdEnv && verificationExplicitlyDisabled && !skipVerificationGate) {
  console.error(
    '[reality-gate] FATAL: URL_VERIFICATION_ENABLED is explicitly false in production.\n' +
      '  Live ingest must perform real URL probes so opportunities surfaced as\n' +
      '  "verified" actually were. Either remove URL_VERIFICATION_ENABLED=false\n' +
      '  or set GRANTFLOW_SKIP_VERIFICATION_GATE=true to acknowledge a seed/import boot.',
  )
  process.exit(1)
}

// Default-on in production: if the operator never set the var, behave as if
// they had set it to true. This is the mission-aligned default and removes the
// silent "verification was off because nobody flipped the flag" failure mode.
if (isProdEnv && !verificationExplicitlyEnabled && !verificationExplicitlyDisabled) {
  process.env.URL_VERIFICATION_ENABLED = 'true'
  console.info(
    '[reality-gate] URL_VERIFICATION_ENABLED defaulted to true (production mission rule).',
  )
}

const URL_VERIFICATION_ENABLED =
  String(process.env.URL_VERIFICATION_ENABLED || '').toLowerCase() === 'true'

if (!isProdEnv && !URL_VERIFICATION_ENABLED && !skipVerificationGate) {
  console.warn(
    '[reality-gate] URL_VERIFICATION_ENABLED is not set. Live URL probing will be skipped at ingest.\n' +
      '  Set URL_VERIFICATION_ENABLED=true to enable, or GRANTFLOW_SKIP_VERIFICATION_GATE=true to silence this warning.',
  )
}
let storageStatus = {
  uploads_dir: uploadsDir,
  legacy_uploads_dir: legacyUploadsDir,
  writable: false,
  likely_persistent: isLikelyPersistentPath(uploadsDir),
  status: 'unknown', // ok|degraded|error|unknown
  last_error: null,
  checked_at: new Date().toISOString(),
}

try {
  const writable = await ensureUploadsDirWritable(uploadsDir)
  storageStatus = {
    ...storageStatus,
    writable: Boolean(writable?.ok),
    last_error: writable?.ok ? null : writable?.error || 'uploads_unwritable',
    checked_at: new Date().toISOString(),
  }

  if (isProdEnv) {
    const missingEnv = !String(process.env.UPLOADS_DIR || '').trim()
    const persistentOk = storageStatus.likely_persistent === true
    const writableOk = storageStatus.writable === true
    // Railway production deployments may temporarily lack a volume mount (or a configured UPLOADS_DIR),
    // which would otherwise crash the process and fail healthchecks. If UPLOADS_DIR is missing entirely
    // we allow a degraded boot on Railway so the service can still start; operators can then attach a
    // volume and set UPLOADS_DIR without getting stuck in a deploy-fail loop.
    const allowImplicitEphemeralOnRailway = missingEnv && isRailwayRuntime && !allowEphemeralUploads

    if ((missingEnv || !persistentOk || !writableOk) && !allowEphemeralUploads && !allowImplicitEphemeralOnRailway) {
      const reason = missingEnv
        ? 'UPLOADS_DIR is required in production'
        : !persistentOk
          ? `UPLOADS_DIR is not a likely persistent mount: ${uploadsDir}`
          : `UPLOADS_DIR is not writable: ${uploadsDir}`
      console.error('[storage] FATAL: refusing to boot with non-persistent uploads storage', {
        uploadsDir,
        missingEnv,
        likely_persistent: storageStatus.likely_persistent,
        writable: storageStatus.writable,
        last_error: storageStatus.last_error,
      })
      // Hard fail in production so we never "think it saved" to an ephemeral filesystem.
      process.exit(1)
    }

    if (missingEnv || !persistentOk || !writableOk) {
      storageStatus = { ...storageStatus, status: 'degraded' }
      console.error('[storage] DEGRADED upload storage', {
        uploadsDir,
        missingEnv,
        allowImplicitEphemeralOnRailway,
        isRailwayRuntime,
        likely_persistent: storageStatus.likely_persistent,
        writable: storageStatus.writable,
        last_error: storageStatus.last_error,
      })
    } else {
      storageStatus = { ...storageStatus, status: 'ok' }
    }
  } else {
    storageStatus = { ...storageStatus, status: storageStatus.writable ? 'ok' : 'degraded' }
  }
} catch (error) {
  storageStatus = {
    ...storageStatus,
    status: 'error',
    writable: false,
    last_error: error?.message || String(error),
    checked_at: new Date().toISOString(),
  }
  // fail-fast already handled above; if we got here, still crash in prod, warn in dev.
  if (isProdEnv) {
    console.error('[storage] FATAL upload storage error:', storageStatus.last_error)
    process.exit(1)
  }
  console.error('[storage] Upload storage unavailable (dev mode continuing):', storageStatus.last_error)
}

app.locals.uploads = { uploadsDir, legacyUploadsDir, storageStatus }

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
  'https://app.axiombiolabs.org',
  'https://www.axiombiolabs.org',
  'https://grantflow-production.up.railway.app',
];
const configuredCorsOrigins = Array.isArray(ENV?.corsOrigins) && ENV.corsOrigins.length > 0 ? ENV.corsOrigins : null;

const corsOptions = {
  origin: configuredCorsOrigins && configuredCorsOrigins.length > 0 ? configuredCorsOrigins : defaultCorsOrigins,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Token', 'X-Anya-Token', 'X-Profile-Id', 'X-Request-Id'],
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

// Wrap every request in an AsyncLocalStorage profile context so the SQL
// layer (backend/db/scopedQuery.js) can enforce tenant isolation automatically.
app.use(profileContextMiddleware());

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
} catch {
  // ignore legacy-dir probing failures
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
    let rehydrated = 0
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

      // The ephemeral file is gone. If we have a durable copy in the DB
      // (avatar_data), rehydrate the on-disk cache instead of discarding the
      // reference — this is what lets avatars survive a Railway redeploy.
      let durable = null
      try {
        durable = await db.prepare('SELECT avatar_data FROM profiles WHERE id = ?').get(row.id)
      } catch {
        // avatar_data column may not exist yet (migration pending); treat as no durable copy.
      }
      if (durable?.avatar_data) {
        try {
          const buf = Buffer.isBuffer(durable.avatar_data) ? durable.avatar_data : Buffer.from(durable.avatar_data)
          fs.writeFileSync(fullPath, buf)
          rehydrated += 1
          continue
        } catch (writeErr) {
          console.warn('[startup] could not rehydrate avatar from DB:', writeErr?.message || writeErr)
        }
      }

      // No durable copy: remove the dangling reference so the frontend uses its
      // built-in non-upload fallback instead of spamming 404s.
      await db.prepare('UPDATE profiles SET avatar_url = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.id)
      repaired += 1
    }

    if (repaired > 0 || rehydrated > 0) {
      console.warn('[startup] avatar self-heal', { rehydrated, nulled: repaired })
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
const APP_BASE_PATH = ENV?.appBase || process.env.AUTH_FRONTEND_APP_BASE || process.env.VITE_APP_BASE || '/';
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

// Load persisted runtime secrets (encrypted) if missing from environment.
// This is intended as an emergency stopgap for hosted environments where env var updates are delayed.
try {
  async function restoreRuntimeSecretIfMissing(key) {
    const current = String(process.env[key] || '').trim()
    const looksMissing = !current || current.includes('*')
    if (!looksMissing) return

    const row = await db
      .prepare(
        `
          SELECT value_ciphertext, iv, tag, updated_at
          FROM app_runtime_secrets
          WHERE key = ?
          LIMIT 1
        `,
      )
      .get(key)

    if (row?.value_ciphertext && row?.iv && row?.tag) {
      const restored = decryptRuntimeSecret(row)
      if (restored && String(restored).trim()) {
        process.env[key] = String(restored).trim()
        // Never log full secrets. Only log a short prefix for OpenAI key debugging.
        console.info(`[startup] Restored ${key} from app_runtime_secrets`, {
          updated_at: row.updated_at ?? null,
          ...(key === 'OPENAI_API_KEY' ? { prefix: `${String(process.env[key]).slice(0, 7)}...` } : {}),
        })
      }
    }
  }

  // Restore common secrets used by the Admin Panel + Funding API clients.
  await restoreRuntimeSecretIfMissing('OPENAI_API_KEY')
  await restoreRuntimeSecretIfMissing('RESEND_API_KEY')
  await restoreRuntimeSecretIfMissing('ANTHROPIC_API_KEY')
  await restoreRuntimeSecretIfMissing('ANYA_ADMIN_TOKEN')
  await restoreRuntimeSecretIfMissing('SAM_GOV_PUBLIC_API_KEY')
  await restoreRuntimeSecretIfMissing('SIMPLER_GRANTS_API_KEY')
  await restoreRuntimeSecretIfMissing('API_DATA_GOV_KEY')
  await restoreRuntimeSecretIfMissing('GRANTS_GOV_API_KEY')
} catch (error) {
  console.warn('[startup] Failed to restore runtime secrets:', error?.message || error)
}

// Schema migrations - Add columns if they don't exist
// Table and column names are validated against a whitelist for security
const allowedMigrations = [
  { table: 'organizations', column: 'contact_name', type: 'TEXT' },
  { table: 'organizations', column: 'contact_title', type: 'TEXT' },
  { table: 'profiles', column: 'avatar_url', type: 'TEXT' },
  { table: 'profiles', column: 'user_id', type: 'TEXT REFERENCES users(id) ON DELETE SET NULL' },
  { table: 'crawler_jobs', column: 'result_meta', type: 'TEXT' },
  { table: 'crawler_jobs', column: 'retry_count', type: 'INTEGER DEFAULT 0' },
  { table: 'crawler_jobs', column: 'last_retry_at', type: 'DATETIME' },
  // Crawler stability metadata (idempotency + snapshots + dispatch backpressure)
  { table: 'crawler_jobs', column: 'profile_context_snapshot', type: 'TEXT' },
  { table: 'crawler_jobs', column: 'idempotency_key', type: 'TEXT' },
  { table: 'crawler_jobs', column: 'dispatch_attempts', type: 'INTEGER DEFAULT 0' },
  { table: 'crawler_jobs', column: 'next_dispatch_at', type: 'DATETIME' },
  // Heartbeat for long-running jobs (prevents stale cleanup of active jobs)
  { table: 'crawler_jobs', column: 'last_heartbeat_at', type: 'DATETIME' },
  // Positive classification for "REAL" opportunity invariants
  { table: 'funding_opportunities', column: 'record_origin', type: "TEXT DEFAULT 'live_crawl'" },
  { table: 'funding_opportunities', column: 'evidence_url', type: 'TEXT' },
  { table: 'funding_opportunities', column: 'last_verified_at', type: 'DATETIME' },
  // Link documents to per-school university applications (student profiles)
  { table: 'documents', column: 'university_application_id', type: 'TEXT' },
  { table: 'documents', column: 'university_application_name', type: 'TEXT' },
  // Password auth (first-login password setup + password login)
  { table: 'users', column: 'password_hash', type: 'TEXT' },
  // Grant application guidance (how to apply)
  { table: 'grants', column: 'application_method', type: 'TEXT' },
  { table: 'grants', column: 'application_steps', type: 'TEXT' },
  { table: 'grants', column: 'contact_name', type: 'TEXT' },
  { table: 'grants', column: 'contact_email', type: 'TEXT' },
  { table: 'grants', column: 'contact_phone', type: 'TEXT' },
  // Loan/grants filtering (realCrawlers buildCandidateOpportunityQuery)
  { table: 'funding_opportunities', column: 'is_loan', type: 'INTEGER DEFAULT 0' },
  // Crawl metadata analysis blob (migration 032 / crawl metadata)
  { table: 'crawl_metadata', column: 'analysis_json', type: 'TEXT' },
];

const validTables = new Set(['profiles', 'crawler_jobs', 'users', 'organizations', 'grants', 'funding_opportunities', 'documents', 'crawl_metadata']);
const validColumnPattern = /^[a-z_]+$/;

// Apply full schema first so fresh DBs (e.g. unit tests) have base tables, then add any missing columns.
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

// MIGRATE_ON_BOOT: apply any pending SQL migrations from backend/db/(postgres/)migrations
// and emit a single `schema check: OK|DRIFT` line. This is the canonical way to keep
// production in sync with new migrations.
//
// DEFAULT: ON (opt out with MIGRATE_ON_BOOT=0|false|no|off). Every migration in the
// repo is idempotent (CREATE TABLE IF NOT EXISTS / ALTER ... IF EXISTS), and the
// outer try/catch below isolates any failure from the rest of the boot. Defaulting
// to off was producing real production outages — e.g. the Agent Control Center
// reporting "relation \"robert_runs\" does not exist" because operators didn't know
// they had to flip the flag manually after a deploy that added new agent telemetry
// tables (sam_runs, robert_*, john_*, agent_activity_events, agent_daily_rollups,
// hamilton_*, agent_control_*).
const migrateOnBootEnv = String(process.env.MIGRATE_ON_BOOT || '').trim()
const explicitlyOptedOut = /^(0|false|no|off)$/i.test(migrateOnBootEnv)
const explicitlyOptedIn = /^(1|true|yes|on)$/i.test(migrateOnBootEnv)
// In smoke mode the integration tests bootstrap a fresh sqlite DB from
// `schema.sql` and then exercise specific routes; replaying every historical
// migration on top of that schema produces real conflicts (e.g. adding
// columns/triggers the test fixtures don't account for) and breaks the
// avatar/upload/profile tests that rely on a clean fixture. Tests that
// genuinely need migrations applied set MIGRATE_ON_BOOT=1 explicitly.
const _smokeMode =
  /^(1|true|yes|on)$/i.test(String(process.env.SMOKE_MODE || '').trim().toLowerCase())
const shouldMigrateOnBoot = explicitlyOptedIn || (!explicitlyOptedOut && !_smokeMode)
if (shouldMigrateOnBoot && !app.locals.db_startup_error) {
  try {
    const { runPendingMigrationsOnBoot } = await import('./db/migrate.js')
    await runPendingMigrationsOnBoot({ logger: console })
  } catch (bootMigrateErr) {
    console.error('[migrate:boot] failed:', bootMigrateErr?.message || bootMigrateErr)
  }
}

// Mission Control / Agent Control Center self-heal.
//
// Runs UNCONDITIONALLY (regardless of MIGRATE_ON_BOOT / SMOKE_MODE),
// because the agent telemetry + control-center tables must exist for the
// admin dashboard to show real status instead of "Agent Not installed".
// Every file applied here is pure DDL with IF NOT EXISTS / IF EXISTS
// guards (also covered by schema.sql for fresh sqlite fixtures), so this
// is a strict no-op on a fully-migrated DB and a self-heal on a partially-
// migrated one. Per-file try/catch inside the helper means a single bad
// file (e.g. transient PG lock) cannot prevent the rest from applying or
// block the server from coming up.
if (!app.locals.db_startup_error) {
  try {
    const { ensureAgentSubsystemTables } = await import(
      './utils/ensureAgentSubsystemTables.js'
    )
    await ensureAgentSubsystemTables(db, { logger: console })
  } catch (agentSelfHealErr) {
    console.warn(
      '[agent-subsystem] startup self-heal threw (non-fatal):',
      agentSelfHealErr?.message || agentSelfHealErr,
    )
  }

  // Funding Library self-heal: guarantee the funding_opportunities reality-gate
  // columns exist even if the strict migration chain stalled before 0073.
  // Without these, every crawler/connector/Robert write fails with
  // `column "reality_status" ... does not exist` and the library can't grow.
  try {
    const { ensureFundingOpportunitySchema } = await import(
      './utils/ensureFundingOpportunitySchema.js'
    )
    await ensureFundingOpportunitySchema(db, { logger: console })
  } catch (fundingSelfHealErr) {
    console.warn(
      '[funding-schema] startup self-heal threw (non-fatal):',
      fundingSelfHealErr?.message || fundingSelfHealErr,
    )
  }

  // Hamilton self-heal: resync the application_tasks status CHECK constraint to
  // the full TASK_STATUSES list at boot. ensureApplicationTaskSchema() drops and
  // re-adds the constraint from the JS source of truth, but it only ran lazily
  // (first store call) — and prod's queue stays empty (browser automation gated
  // off), so it never fired and the constraint stayed stuck on the pre-087
  // 14-status list. Any task advancing to a new-state-machine status like
  // 'analyzing'/'completed' then threw `application_tasks_status_check` and
  // Hamilton could neither create nor progress a task. Running it
  // unconditionally at boot makes it drift-proof.
  try {
    const { ensureApplicationTaskSchema } = await import(
      './services/hamilton/applicationTaskStore.js'
    )
    await ensureApplicationTaskSchema(db)
  } catch (taskSchemaSelfHealErr) {
    console.warn(
      '[application-tasks] startup self-heal threw (non-fatal):',
      taskSchemaSelfHealErr?.message || taskSchemaSelfHealErr,
    )
  }

  // Register the Yana-backed lead source so John drafts outreach from Yana's
  // qualified client-discovery leads (johnYanaBridge). Yana = Client Discoverer.
  try {
    const [{ registerLeadSource }, { makeYanaLeadSource }] = await Promise.all([
      import('./services/john/johnYanaBridge.js'),
      import('./services/yana/yanaLeadDiscovery.js'),
    ])
    registerLeadSource(makeYanaLeadSource(db))
  } catch (leadSrcErr) {
    console.warn(
      '[yana] could not register lead source for John (non-fatal):',
      leadSrcErr?.message || leadSrcErr,
    )
  }
}

// Then add columns that may be missing (schema.sql may not include every migration column).
// This legacy auto-migration is SQLite-only. Postgres must be migrated deterministically via SQL migrations.
if (db.dialect === 'sqlite') {
  allowedMigrations.forEach(({ table, column, type }) => {
    if (!validTables.has(table) || !validColumnPattern.test(column)) {
      console.error(`Migration error: Invalid table "${table}" or column "${column}"`);
      return;
    }
    try {
      db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`).run();
    } catch (error) {
      if (!error.message.includes('duplicate column')) {
        console.warn(`Migration warning for ${table}.${column}:`, error.message);
      }
    }
  });
} else {
  console.info('[database] Skipping legacy column auto-migrations (dialect !== sqlite)');
  // Idempotent self-heal: list/delete routes filter on organizations.deleted_at (migration 0047).
  // Background migrate in start.js may still be running; avoid transient 500s on /api/organizations.
  try {
    await db.exec('ALTER TABLE organizations ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ')
    await db.exec(
      'CREATE INDEX IF NOT EXISTS idx_organizations_deleted_at ON organizations(deleted_at)',
    )
    // Yana web-crawler enrichment writes a contact person (migration 094/0090).
    await db.exec('ALTER TABLE organizations ADD COLUMN IF NOT EXISTS contact_name TEXT')
    await db.exec('ALTER TABLE organizations ADD COLUMN IF NOT EXISTS contact_title TEXT')
  } catch (e) {
    console.warn(
      '[database] organizations.deleted_at startup ensure failed (run npm run migrate):',
      e?.message || e,
    )
  }

  // Idempotent self-heal: crawler_jobs.type CHECK constraint must include every
  // job type registered in crawlerDispatcher HANDLERS. When a new type is
  // shipped (e.g. 'student_bridge_funding' migration 0067) operators don't
  // always set MIGRATE_ON_BOOT=1, so /api/crawlers/jobs would 500 with PG
  // 23514 until they did. Mirror migration 0067 inline so the new type is
  // accepted on the very first request after deploy. Keep the type-list in
  // sync with backend/services/crawlerJobCreation.js VALID_TYPES.
  try {
    await db.exec(`
      DO $$
      DECLARE
        constraint_name text;
      BEGIN
        SELECT c.conname
        INTO constraint_name
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        WHERE t.relname = 'crawler_jobs'
          AND c.contype = 'c'
          AND pg_get_constraintdef(c.oid) ILIKE '%CHECK%'
          AND pg_get_constraintdef(c.oid) ILIKE '%type%'
        LIMIT 1;

        IF constraint_name IS NOT NULL THEN
          EXECUTE format('ALTER TABLE crawler_jobs DROP CONSTRAINT IF EXISTS %I', constraint_name);
        END IF;
      END $$;
    `)
    await db.exec(`
      ALTER TABLE crawler_jobs
        ADD CONSTRAINT crawler_jobs_type_check
        CHECK (type IN (
          'local',
          'scholarship',
          'curated_benefits',
          'health_resources',
          'comprehensive',
          'national',
          'item_search',
          'item_gift_search',
          'avatar_lookup',
          'document_ingest',
          'pipeline_automation',
          'profile_enrichment',
          'national_zip_scan',
          'portal_check',
          'government_funding',
          'student_grants',
          'student_bridge_funding',
          'ecf_benefits',
          'special_needs',
          'local_funding',
          'item_matching',
          'anya_match_scout'
        ))
    `)
  } catch (e) {
    console.warn(
      '[database] crawler_jobs.type CHECK self-heal failed (run npm run migrate to apply 0067/0069):',
      e?.message || e,
    )
  }

  // Idempotent self-heal: anya_match_suggestions (migration 0068).
  // The Match Scout writes here; the recommend-only popup + notification
  // bell read from it. Without this table the scout's INSERT fails with
  // PG 42P01 ("relation does not exist") on a fresh deploy where
  // MIGRATE_ON_BOOT=0.
  try {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS anya_match_suggestions (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        user_id TEXT,
        opportunity_id TEXT,
        title TEXT NOT NULL,
        funder TEXT,
        match_score REAL NOT NULL,
        match_reasons JSONB,
        need_summary JSONB,
        search_strategy JSONB,
        opportunity_data JSONB,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'accepted', 'dismissed', 'already_in_pipeline', 'expired')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        acted_at TIMESTAMPTZ,
        action_result TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_anya_match_suggestions_profile
        ON anya_match_suggestions(profile_id);
      CREATE INDEX IF NOT EXISTS idx_anya_match_suggestions_user
        ON anya_match_suggestions(user_id);
      CREATE INDEX IF NOT EXISTS idx_anya_match_suggestions_status
        ON anya_match_suggestions(status);
      CREATE INDEX IF NOT EXISTS idx_anya_match_suggestions_opportunity
        ON anya_match_suggestions(opportunity_id);
      CREATE INDEX IF NOT EXISTS idx_anya_match_suggestions_created
        ON anya_match_suggestions(created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_anya_match_suggestions_active_pair
        ON anya_match_suggestions(profile_id, opportunity_id)
        WHERE status = 'pending';
    `)
  } catch (e) {
    console.warn(
      '[database] anya_match_suggestions self-heal failed (run npm run migrate to apply 0068):',
      e?.message || e,
    )
  }

  try {
    if (db.dialect === 'postgres') {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS matching_low_coverage_events (
          id BIGSERIAL PRIMARY KEY,
          profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
          search_terms TEXT,
          free_text TEXT,
          qualified_count INTEGER NOT NULL DEFAULT 0,
          min_score INTEGER NOT NULL DEFAULT 50,
          intent_label TEXT,
          branded_program TEXT,
          recorded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_matching_low_coverage_recorded
          ON matching_low_coverage_events(recorded_at DESC);
      `)
    } else {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS matching_low_coverage_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          profile_id TEXT,
          search_terms TEXT,
          free_text TEXT,
          qualified_count INTEGER NOT NULL DEFAULT 0,
          min_score INTEGER NOT NULL DEFAULT 50,
          intent_label TEXT,
          branded_program TEXT,
          recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_matching_low_coverage_recorded
          ON matching_low_coverage_events(recorded_at DESC);
      `)
    }
  } catch (e) {
    console.warn('[database] matching_low_coverage_events self-heal failed:', e?.message || e)
  }

  // Idempotent self-heal: funding_opportunities verification metadata + reality
  // gate columns (migrations 0061 + 0062). Several writers — including the new
  // student bridge funding pipeline — assume these columns exist and crash
  // with PG 42703 when production hasn't run migrations yet.
  try {
    await db.exec(`
      ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS discovered_at TIMESTAMPTZ;
      ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS verification_method TEXT;
      ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS verified_by TEXT;
      ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS verification_error TEXT;
      ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS link_status_code INTEGER;
      ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS opportunity_kind TEXT;
      ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS source_trust_tier TEXT;
    `)
  } catch (e) {
    console.warn(
      '[database] funding_opportunities verification + kind/trust self-heal failed (run npm run migrate to apply 0061 + 0062):',
      e?.message || e,
    )
  }
}

// Production hardening (SQLite): if the DB was created before profiles existed (or after an ephemeral reset),
// `/api/profiles` will 5xx and upstream proxies often surface it as 502. We self-heal by applying schema.sql
// when core tables are missing. This is intentionally SQLite-only; Postgres must use deterministic migrations.
if (db.dialect === 'sqlite') {
  try {
    let missingCore = false
    const tablesToCheck = ['profiles', 'profile_sections', 'documents', 'crawler_jobs', 'users']
    for (const table of tablesToCheck) {
      try {
        db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()
      } catch (error) {
        const msg = String(error?.message || error)
        if (msg.includes('no such table') || msg.includes('SQLITE_ERROR')) {
          missingCore = true
          console.warn('[database] Detected missing core table; will apply schema.sql', {
            table,
            error: msg,
          })
          break
        }
      }
    }

    if (missingCore) {
      const schemaPath = join(__dirname, 'db', 'schema.sql')
      if (fs.existsSync(schemaPath)) {
        const schema = fs.readFileSync(schemaPath, 'utf8')
        await db.exec(schema)
        console.info('[database] Schema applied (self-heal)', { dialect: db.dialect })
      } else {
        console.error('[database] schema.sql missing; cannot self-heal sqlite schema', { schemaPath })
      }
    }
  } catch (error) {
    console.error('[database] Failed during sqlite schema self-heal:', error?.message || error)
  }
}

function ensureCrawlerJobsSupportsAllTypes() {
  // SQLite-only safety: older local DBs may have an outdated CHECK constraint on crawler_jobs.type.
  // If it rejects any currently-supported type, rebuild the table with the modern constraint.
  const testTypes = [
    'local',
    'scholarship',
    'health_resources',
    'comprehensive',
    'national',
    'item_search',
    'item_gift_search',
    'avatar_lookup',
    'document_ingest',
    'pipeline_automation',
    'profile_enrichment',
    'national_zip_scan',
  ]
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
            'health_resources',
            'comprehensive',
            'national',
            'item_search',
            'item_gift_search',
            'avatar_lookup',
            'document_ingest',
            'pipeline_automation',
            'profile_enrichment',
            'national_zip_scan'
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
          profile_context_snapshot TEXT,
          idempotency_key TEXT,
          result_count INTEGER DEFAULT 0,
          result_meta TEXT,
          error TEXT,
          requested_by TEXT,
          dispatch_attempts INTEGER DEFAULT 0,
          next_dispatch_at DATETIME,
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
          profile_context_snapshot,
          idempotency_key,
          result_count,
          result_meta,
          error,
          requested_by,
          dispatch_attempts,
          next_dispatch_at,
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
          NULL as profile_context_snapshot,
          NULL as idempotency_key,
          result_count,
          result_meta,
          error,
          requested_by,
          0 as dispatch_attempts,
          NULL as next_dispatch_at,
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
    db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_crawler_jobs_idempotency ON crawler_jobs(idempotency_key) WHERE idempotency_key IS NOT NULL').run()
  })

  rebuild()
}

if (db.dialect === 'sqlite') {
  ensureCrawlerJobsSupportsAllTypes()
}

// Smoke mode: used by unit/contract tests (fast deterministic boot).
// Many unit tests start the server with PORT=0 + DB_AUTO_MIGRATE=true but do not set SMOKE_MODE explicitly.
// In that case, we infer smoke mode so that heavy startup tasks never block the "Ready" signal.
const explicitSmoke = ['1', 'true', 'yes', 'on'].includes(String(process.env.SMOKE_MODE || '').trim().toLowerCase())
const inferredSmoke =
  String(PORT) === '0' &&
  String(process.env.DB_AUTO_MIGRATE || '').trim().toLowerCase() === 'true' &&
  String(process.env.NODE_ENV || '').trim().toLowerCase() !== 'production'
const IS_SMOKE_MODE = explicitSmoke || inferredSmoke

// Restore baseline data (profiles + sections, plus other seed tables if DB appears empty).
// This makes the app self-heal after an ephemeral DB reset, so "real profiles" reappear on next login.
// IMPORTANT: If DB is unavailable (degraded mode), skip all startup DB operations so the process
// stays alive and health/admin endpoints remain reachable for diagnosis.
if (app.locals.db_startup_error) {
  console.warn('[startup] Skipping all startup DB operations (database unavailable):', app.locals.db_startup_error)
} else if (IS_SMOKE_MODE) {
  // Contract/unit tests start the backend in "smoke" mode and only need a fast, deterministic boot.
  // Heavy boot tasks (baseline seeding, network-dependent backfills, large DB scans) must not block PORT binding.
  console.info('[startup] SMOKE_MODE enabled; skipping baseline seed + heavy startup tasks')
  // Still ensure core fixtures exist so auth/access tests have profiles to attach to.
  try {
    await ensureDesignatedProfiles(db)
    await linkAllProfilesToAdmin(db)
    await ensureUserPreferencesTable(db)
  } catch (error) {
    console.warn('[startup] Smoke mode fixture setup failed:', error?.message || error)
  }
} else {
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
    try {
      await ensureDesignatedProfiles(db)
    } catch (fallbackError) {
      console.warn('[startup] Designated profiles fallback also failed:', fallbackError?.message || fallbackError)
    }
  }
  // Always ensure designated profiles exist (idempotent); baseline seed may not include newer fixtures.
  try {
    await ensureDesignatedProfiles(db)
    await linkAllProfilesToAdmin(db)
  } catch (error) {
    console.warn('[startup] Failed to ensure designated profiles / admin links:', error?.message || error)
  }
  // Prevent "orphaned profiles" by ensuring every active profile has an organization_id.
  // Bounded + idempotent so production startups stay safe.
  try {
    await ensureProfileOrgLinks(db, {
      limit: Number(process.env.STARTUP_PROFILE_ORG_LINK_LIMIT || 5000),
      includeDeleted: false,
      dryRun: false,
    })
  } catch (error) {
    console.warn('[startup] Failed to ensure profile organization links:', error?.message || error)
  }
  try {
    await ensureUserPreferencesTable(db)
    await repairInvalidDocumentStatuses(db)
    await repairMissingUploadAvatars({ db, uploadsDir })
  } catch (error) {
    console.warn('[startup] Failed to run post-seed repairs:', error?.message || error)
  }
}

// Ensure the Payment Sheet service catalog + terms exist (fast + idempotent).
if (IS_SMOKE_MODE) {
  console.info('[startup] Skipping service catalog seeding (SMOKE_MODE)')
} else {
  try {
    await seedServiceCatalogFromExtract(db)
  } catch (error) {
    console.warn('[startup] Failed to seed service catalog from extract:', error?.message || error)
  }
}

// Check funding opportunities count and provide guidance
if (!IS_SMOKE_MODE && db.dialect === 'sqlite') {
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
  console.info('[startup] Skipping SQLite-only opportunity seeding checks', { smoke: IS_SMOKE_MODE, dialect: db.dialect })
}

function parseBoolEnv(value) {
  if ((value === null || value === undefined)) return null
  const v = String(value).trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(v)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(v)) return false
  return null
}

const BACKGROUND_SERVICES_DISABLED =
  IS_SMOKE_MODE || parseBoolEnv(process.env.DISABLE_BACKGROUND_SERVICES) === true

// Ensure at least N REAL national opportunities are available (visible from any ZIP).
// - Non-prod: default ON (local reliability).
// - Prod: default OFF unless first-boot (no opportunities at all) or explicitly enabled.
try {
  if (IS_SMOKE_MODE) {
    console.info('[startup]', JSON.stringify({ event: 'min_national_ensure', enabled_by: 'smoke_mode', minimum: null, skipped: true }))
  } else {
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
  }
} catch (error) {
  console.warn('[startup] Failed to ensure national minimum opportunities:', error?.message || error)
}

// Ensure curated assistance directories are available even when the DB already has many county_crawler records.
// This increases "real & relevant" coverage for special needs / emergency assistance matching without fabricating data.
try {
  if (IS_SMOKE_MODE) {
    console.info('[startup] Skipping assistance directory seeding (SMOKE_MODE)')
  } else if (db.dialect !== 'sqlite') {
    // This helper is SQLite-only today (sync calls + local JSON files). Skip on Postgres until refactored.
    console.info('[startup] Skipping assistance directory seeding (dialect !== sqlite)')
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

if (IS_SMOKE_MODE) {
  console.info('[startup] Skipping faith-based housing seeding (SMOKE_MODE)')
} else {
  try {
    const faithRow = await db
      .prepare("SELECT COUNT(*) as count FROM funding_opportunities WHERE source = 'faith_based_assistance' AND state = 'OH' AND is_active = 1")
      .get()
    const faithCount = faithRow?.count ?? 0
    if (faithCount < 6) {
      console.info('[startup] Seeding faith-based housing assistance (Lorain County OH)...')
      const result = await seedFaithBasedHousing(db)
      const afterRow = await db
        .prepare("SELECT COUNT(*) as count FROM funding_opportunities WHERE source = 'faith_based_assistance' AND state = 'OH' AND is_active = 1")
        .get()
      console.info('[startup] Seeded faith-based housing', { ...result, after: afterRow?.count })
    } else {
      console.info('[startup] Faith-based housing already seeded', { count: faithCount })
    }
  } catch (error) {
    console.warn('[startup] Failed to seed faith-based housing:', error?.message || error)
  }
}

// ── Housing Funding Opportunities ──
if (IS_SMOKE_MODE) {
  console.info('[startup] Skipping housing funding seeding (SMOKE_MODE)')
} else {
  try {
    const housingRow = await db
      .prepare("SELECT COUNT(*) as count FROM funding_opportunities WHERE funding_category IS NOT NULL AND usable_for_housing = 1 AND is_active = 1")
      .get()
    const housingCount = housingRow?.count ?? 0
    if (housingCount < 5) {
      console.info('[startup] Seeding housing-eligible funding opportunities...')
      const result = await seedHousingFundingOpportunities(db)
      console.info('[startup] Seeded housing funding', result)
    } else {
      console.info('[startup] Housing funding already seeded', { count: housingCount })
    }
  } catch (error) {
    console.warn('[startup] Failed to seed housing funding:', error?.message || error)
  }
}

function resolveJwtSecret() {
  const raw = String(process.env.AUTH_JWT_SECRET || process.env.JWT_SECRET || '').trim();
  const isProd = process.env.NODE_ENV === 'production';

  if (!raw) {
    if (isProd) {
      // FAIL FAST in production - do not generate ephemeral secrets
      console.error(
        'FATAL ERROR: Missing AUTH_JWT_SECRET (or JWT_SECRET) in production.\n' +
          'Set a strong random secret (recommended: 32+ bytes) and redeploy.\n' +
          '  AUTH_JWT_SECRET="..."\n' +
          'The application cannot start without a stable JWT secret.',
      );
      process.exit(1);
    }
    console.warn('[startup] AUTH_JWT_SECRET not set; using insecure development default (DO NOT use in production).');
    return 'grantflow-dev-secret';
  }

  if (isProd && raw === 'grantflow-dev-secret') {
    // FAIL FAST in production - do not use insecure defaults
    console.error(
      'FATAL ERROR: AUTH_JWT_SECRET is set to the insecure development default in production.\n' +
        'Generate a strong random secret and redeploy.\n' +
        'Example: openssl rand -base64 48',
    );
    process.exit(1);
  }
  return String(raw || '').trim()
}

const EFFECTIVE_JWT_SECRET = resolveJwtSecret()
const isProd = process.env.NODE_ENV === 'production'

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
    (safeTokenEqual(xAdminToken, expectedAdminToken) ||
      safeTokenEqual(xAdminToken, expectedBulkKey))
  ) {
    user = {
      role: 'admin',
      // Canonical admin is DB-backed via req.ctx. We still mark this token flow as admin,
      // but requestContext will resolve the final answer from users.is_admin.
      is_admin: true,
      // Deterministic userId so we can back it with a real DB user row (users.is_admin = true).
      userId: 'system_admin_token',
      profileId: null,
      full_name: ADMIN_NAME,
      email: ADMIN_EMAIL,
    };
    handled = true;
  }

  // 2. Check X-Anya-Token (autonomous bot)
  if (!handled && xAnyaToken && safeTokenEqual(xAnyaToken, process.env.ANYA_API_KEY)) {
    user = {
      role: 'admin',
      is_admin: true,
      userId: 'system_anya_token',
      full_name: 'Anya Assistant',
      email: 'anya@grantflow.app',
    };
    handled = true;
  }

  // 3. Check Authorization Bearer token
  if (!handled && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token) {
      // Accept admin/bulk tokens via Authorization header for frontend/dev compatibility.
      // This does NOT expand the trust boundary; these same tokens are already accepted via X-Admin-Token.
      if (
        safeTokenEqual(token, expectedAdminToken) ||
        safeTokenEqual(token, expectedBulkKey)
      ) {
        user = {
          role: 'admin',
          is_admin: true,
          userId: 'system_admin_token',
          profileId: null,
          full_name: ADMIN_NAME,
          email: ADMIN_EMAIL,
        }
        handled = true
      }

      // Allow the Anya API key to authenticate via Authorization bearer as well.
      if (!handled && safeTokenEqual(token, process.env.ANYA_API_KEY)) {
        user = {
          role: 'admin',
          is_admin: true,
          userId: 'system_anya_token',
          full_name: 'Anya Assistant',
          email: 'anya@grantflow.app',
        }
        handled = true
      }

      if (!handled) {
        try {
          const payload = jwt.verify(token, EFFECTIVE_JWT_SECRET);
        // Stateless JWT acceptance (important for multi-instance deployments where SQLite session storage
        // is not shared across instances). If the token is correctly signed and unexpired, trust its claims.
        // We still try to validate against DB sessions when available, but we do not require it.
        let tokenRoles = []
        let tokenIsAdmin = false
        let tokenEmail = null
        let tokenName = null

        if (payload && typeof payload === 'object') {
          tokenRoles = Array.isArray(payload.roles) ? payload.roles : []
          tokenIsAdmin = tokenRoles.includes('admin')
          tokenEmail = payload.email ?? null
          tokenName = payload.name ?? null

          if (payload.sub) {
            user = {
              role: tokenIsAdmin ? 'admin' : 'user',
              is_admin: Boolean(tokenIsAdmin),
              userId: payload.sub,
              profileId: payload.profile_id ?? null,
              sessionId: payload.sid ?? null,
              full_name: tokenName,
              email: tokenEmail,
              roles: tokenRoles,
            }
            handled = true
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
            // Admin is DB-backed: users.is_admin.
            // Never downgrade admin if the token already claims it (e.g. admin token, DB lag).
            const effectiveIsAdmin = Boolean(tokenIsAdmin || sessionRow.is_admin)
            user = {
              role: effectiveIsAdmin ? 'admin' : 'user',
              is_admin: effectiveIsAdmin,
              userId: sessionRow.user_id,
              profileId: payload.profile_id ?? sessionRow.profile_id ?? null,
              sessionId: sessionRow.id,
              full_name: sessionRow.display_name ?? tokenName ?? null,
              email: sessionRow.primary_email ?? tokenEmail ?? null,
              roles: tokenRoles,
            }
            handled = true;
          }
        }
        } catch (error) {
          // fall through to legacy handling
        }
      }
    }

    if (!handled && token && safeTokenEqual(token, ADMIN_TOKEN)) {
      user = {
        role: 'admin',
        is_admin: true,
        userId: 'system_admin_token',
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
            VALUES (?, ?, ?, ?)
          `,
        )
        .run(
          user.userId,
          user.full_name || ADMIN_NAME || 'Admin User',
          user.email || ADMIN_EMAIL || null,
          true,
        )
    }
  } catch {
    // Best-effort only: do not block requests if the users table is unavailable.
  }

  return next()
})

// Attach canonical request context (MUST run after auth middleware)
// This provides req.ctx with userId, email, isAdmin (DB-backed), accessible profiles/orgs
app.use(attachRequestContext())

// Health check with dependency checks
// Health check endpoint (v3.0 - complete county data)

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
      return res.status(401).json({ error: 'unauthorized' });
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
        return res.status(503).json({
          error: 'service_unavailable',
          error_type: 'database_error',
          message: 'Auth service temporarily unavailable. Please retry shortly.',
        })
      }

      if (!dbUser) {
        // Dev/admin token convenience: ADMIN_TOKEN can authenticate an admin user without a stored user record.
        // Create the user record on-demand so the frontend auth bootstrap (`/api/auth/me`) is not brittle.
        if (user.role === 'admin' || user.is_admin === true) {
          try {
            db.prepare(
              `
                INSERT INTO users (id, display_name, primary_email, is_admin)
                VALUES (?, ?, ?, ?)
              `,
            ).run(
              user.userId,
              user.full_name || ADMIN_NAME || 'Admin User',
              user.email || ADMIN_EMAIL || null,
              true,
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
          return res.status(401).json({ error: 'unauthorized' });
        }
      }

      try {
        const isAdminUser =
          Boolean(dbUser?.is_admin) || user.role === 'admin' || user.is_admin === true

        if (isAdminUser) {
          // Admin UX expects cross-org profile selection.
          // Return a large (but bounded) list to avoid "missing profiles" in the UI.
          profiles = await req.db
            .prepare(
              `
                SELECT id, display_name, organization_id, status
                FROM profiles
                ORDER BY created_at DESC
                LIMIT 1000
              `,
            )
            .all()

          // Lightweight, actionable logging for the "missing profiles" failure mode.
          if (Array.isArray(profiles) && profiles.length === 0) {
            console.warn('[/api/auth/me] Admin profile list is empty (expected baseline profiles)', {
              user_id: dbUser?.id ?? null,
            })
          }
        } else {
          const emails = Array.from(
            new Set(
              [dbUser?.primary_email, user?.email]
                .map((v) => String(v || '').trim().toLowerCase())
                .filter(Boolean),
            ),
          )

          // Ensure schema exists (idempotent). If it fails, fall back to user_id only.
          try {
            await ensureProfileEmailSchema(req.db)
          } catch {
            // ignore
          }

          if (emails.length > 0) {
            const placeholders = emails.map(() => '?').join(', ')
            profiles = await req.db
              .prepare(
                `
                  SELECT DISTINCT p.id, p.display_name, p.organization_id, p.status
                  FROM profiles p
                  LEFT JOIN profile_emails pe ON pe.profile_id = p.id
                  WHERE p.user_id = ?
                     OR lower(pe.email) IN (${placeholders})
                  ORDER BY p.created_at ASC
                `,
              )
              .all(dbUser.id, ...emails)
          } else {
            profiles = await req.db
              .prepare(
                `
                  SELECT id, display_name, organization_id, status
                  FROM profiles
                  WHERE user_id = ?
                  ORDER BY created_at ASC
                `,
              )
              .all(dbUser.id)
          }
        }
      } catch (dbError) {
        console.error('[/api/auth/me] Database error fetching profiles:', dbError);
        // Return user data without profiles if profiles query fails (avoid 5xx for auth bootstrap).
        profiles = [];
      }

      // Do not "bleed" into an arbitrary profile_id from the token; only use it if it’s in the accessible list.
      const profileIds = new Set((profiles || []).map((p) => p?.id).filter(Boolean))
      const safeActiveProfileId = user.profileId && profileIds.has(user.profileId) ? user.profileId : profiles?.[0]?.id ?? null

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
        active_profile_id: safeActiveProfileId,
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
    return res.status(503).json({
      error: 'service_unavailable',
      error_type: 'internal_error',
      message: 'Auth service temporarily unavailable. Please retry shortly.',
    })
  }
});

// Pipeline monitoring (zero-result + slow-response tracking)
app.use(pipelineMonitor())

// Pipeline health dashboard (admin-only)
app.get('/api/admin/pipeline-health', (req, res) => {
  res.json(getPipelineHealth())
})

// API routes
app.use('/api/auth', authRouter);
app.use('/api/activity', activityRouter);
// Conversational onboarding — public, no auth required. This is the SINGLE
// entry funnel for new GrantFlow users: /start in the SPA talks to these
// endpoints, finishes by creating a profile + email-OTP credential, and hands
// the user off to /api/auth/email/verify with a stateless token.
app.use('/api/onboarding', lazyRouter('./routes/onboarding.js'));
app.use('/api/service-application', lazyRouter('./routes/serviceApplication.js'));
app.use('/api/billing', billingRouter);
app.use('/api/stats', responseCache(60_000), statsRouter);
app.use('/api/services', servicesRouter);
app.use('/api/stripe', stripeRouter);
app.use('/api/admin/service-catalog', adminServiceCatalogRouter)
app.use('/api/admin/queue', adminQueueOpsRouter)
app.use('/api/organizations', organizationsRouter);
app.use('/api/grants', grantsRouter);
app.use('/api/opportunities', opportunitiesRouter);
app.use('/api/pricing', lazyRouter('./routes/pricing.js'));
app.use('/api/sam/onboarding-audit', lazyRouter('./routes/samOnboardingAudit.js'));
app.use('/api/funding-library', lazyRouter('./routes/fundingLibrary.js'));
app.use('/api/programs', programsRouter);
app.use('/api/milestones', milestonesRouter);
app.use('/api/documents', documentsRouter);
app.use('/api/expenses', expensesRouter);
app.use('/api/budgets', budgetsRouter);
app.use('/api/contacts', contactsRouter);
app.use('/api/outreach-logs', outreachLogsRouter);
app.use('/api/application-drafts', applicationDraftsRouter);
app.use('/api/applications', applicationsRouter);
app.use('/api/grant-applications', grantApplicationsRouter);
app.use('/api/application-workflow', applicationWorkflowRouter);
app.use('/api/vnext/applications', lazyRouter('./routes/vnextApplications.js'));
app.use('/api/billing-settings', billingSettingsRouter);
app.use('/api/contact-methods', contactMethodsRouter);
app.use('/api/source-directory', sourceDirectoryRouter);
app.use('/api/items', itemsRouter);
// Mission Goal 11 — expose the canonical field-usage registry to the UI/Anya.
app.use('/api/field-usage', lazyRouter('./routes/fieldUsage.js'));
// Mission Goal 4/5/9 — single canonical profile-type list shared by every UI selector.
app.use('/api/profile-types', lazyRouter('./routes/profileTypes.js'));
const PIPELINE_TIMEOUT = Number(process.env.PIPELINE_TIMEOUT_MS || 30000)
app.use('/api/ai', requestTimeout(PIPELINE_TIMEOUT), aiRouter);
// Anya Match Scout — recommend-only background suggestions. Mounted BEFORE
// the generic /api/anya router so the /match-suggestions/* sub-paths
// resolve here cleanly and don't accidentally collide with any future
// `/api/anya/match-suggestions/*` handler.
app.use('/api/anya/match-suggestions', anyaMatchSuggestionsRouter);
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
// Geo Crawl (admin-only) — register BEFORE generic `app.use('/api', …)` routers so it is never shadowed.
app.use('/api/geo-crawl', lazyRouter('./routes/geoCrawl.js', (mod) => mod.default({ uploadDir: uploadsDir, getOpenAI: null })));
// Function-style endpoints (used by NOFO Parser + Diagnostics)
app.use('/api', lazyRouter('./routes/nofo.js'));
// Legacy function-style endpoints (legacy UI flows: DataSources/SourceDirectory)
app.use('/api', lazyRouter('./routes/legacyFunctions.js'));
// Legacy entity endpoints
app.use('/api/crawl-logs', crawlLogsRouter);
app.use('/api/colleges', collegesRouter);
app.use('/api/notifications', notificationsRouter);
// Yana — student-portal layer + application-task surface. Mounted at /api so
// the /profiles/:id/student-portals path lives alongside the legacy
// /profiles/:id/school-portals routes without colliding with the profiles
// router (which uses :id).
app.use('/api', lazyRouter('./routes/studentPortals.js'));
// Committed-college financial-aid workspace (commit one school → others archive;
// aggregate COA / FAFSA / aid / matched funding / Hamilton status). Same
// /:profileId path convention as studentPortals.
app.use('/api', lazyRouter('./routes/committedCollege.js'));
app.use('/api/application-tasks', lazyRouter('./routes/applicationTasks.js'));
// Hamilton Automation Agent — Application Autopilot / Funding Completion.
// Note: existing Yana = Client Discovery / Lead Funnel and is unchanged.
app.use('/api/hamilton/automation', lazyRouter('./routes/hamiltonAutomation.js'));
// Backwards-compatible alias so any in-flight client still works during
// the rollout. Both paths resolve to the same router.
app.use('/api/yana/automation', lazyRouter('./routes/hamiltonAutomation.js'));
app.use('/api/saved-grants', savedGrantsRouter);
app.use('/api/foundations', foundationsRouter);
// John — Outreach Drafting Agent. Draft-only; never sends. Admin-only except /health.
app.use('/api/john', lazyRouter('./routes/john.js'));
app.use('/api/larry', lazyRouter('./routes/larry.js'));
// Robert — Funding Discovery Agent. Disabled by default; the scheduler
// only starts if ROBERT_ENABLED + ROBERT_RUN_ON_SCHEDULE/STARTUP say so.
app.use('/api/robert', lazyRouter('./routes/robert.js'));

// Sam — production-readiness agent. /api/sam/health is public; everything
// else is admin-gated inside the router. Mounted after the rest of the API
// so Sam's HTTP probes can hit /api/health/* and /readyz cleanly.
app.use('/api/sam', lazyRouter('./routes/sam.js'))

// School-portal bridge — public partner-auth (Bearer API key) routes that let
// a registered school's student-information system push roster data into
// GrantFlow profiles and read back the funding sources the matcher says each
// student is eligible for. Admin sub-routes (/admin/*) gate on req.user.is_admin
// inside the router.
app.use('/api/school-portal', lazyRouter('./routes/schoolPortal.js'))

function resolveBuildSha() {
  return (
    process.env.RAILWAY_GIT_COMMIT_SHA ||
    process.env.GIT_COMMIT_SHA ||
    process.env.COMMIT_SHA ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    null
  )
}

async function scheduleCrawlerSmokeJobs({ db, uploadsDir }) {
  // Goal: prove crawlers can run end-to-end on the currently deployed build, without needing a human
  // to click UI buttons. This runs once per deployed SHA and is intentionally tiny.
  if (process.env.NODE_ENV !== 'production') return

  const sha = resolveBuildSha()
  const suffix = (sha ? String(sha).slice(0, 8) : crypto.randomUUID().slice(0, 8)).replace(/[^a-z0-9_-]/gi, '')

  const profileId = `smoke-profile-${suffix}`
  const documentId = `smoke-document-${suffix}`
  const comprehensiveJobId = `smoke-comprehensive-${suffix}`
  const documentIngestJobId = `smoke-document-ingest-${suffix}`
  const scholarshipJobId = `smoke-scholarship-${suffix}`

  const insertProfileSql =
    db?.dialect === 'postgres'
      ? `
          INSERT INTO profiles (id, display_name, primary_type, status, tags)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (id) DO NOTHING
        `
      : `
          INSERT OR IGNORE INTO profiles (id, display_name, primary_type, status, tags)
          VALUES (?, ?, ?, ?, ?)
        `

  const insertDocumentSql =
    db?.dialect === 'postgres'
      ? `
          INSERT INTO documents (id, profile_id, name, type, extracted_text, processing_status, status)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (id) DO NOTHING
        `
      : `
          INSERT OR IGNORE INTO documents (id, profile_id, name, type, extracted_text, processing_status, status)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `

  const insertJobSql =
    db?.dialect === 'postgres'
      ? `
          INSERT INTO crawler_jobs (id, type, status, profile_id, parameters, requested_by)
          VALUES (?, ?, 'queued', ?, ?, ?)
          ON CONFLICT (id) DO NOTHING
        `
      : `
          INSERT OR IGNORE INTO crawler_jobs (id, type, status, profile_id, parameters, requested_by)
          VALUES (?, ?, 'queued', ?, ?, ?)
        `

  try {
    // Use a student-ish primary_type so scholarship crawler has relevant context.
    await db
      .prepare(insertProfileSql)
      .run(profileId, 'GrantFlow Smoke Profile', 'college_student', 'active', JSON.stringify(['student']))

    await db
      .prepare(insertDocumentSql)
      .run(
        documentId,
        profileId,
        `smoke-${suffix}.txt`,
        'source_material',
        'GrantFlow smoke document (no PII).',
        'pending',
        'draft',
      )

    await db
      .prepare(insertJobSql)
      .run(
        comprehensiveJobId,
        'comprehensive',
        profileId,
        JSON.stringify({ max_results: 1, match_threshold: 80, save_to_database: false }),
        'system-smoke',
      )

    await db
      .prepare(insertJobSql)
      .run(
        scholarshipJobId,
        'scholarship',
        profileId,
        JSON.stringify({ limit: 1 }),
        'system-smoke',
      )

    await db
      .prepare(insertJobSql)
      .run(
        documentIngestJobId,
        'document_ingest',
        profileId,
        JSON.stringify({ document_id: documentId, skip_ai: true }),
        'system-smoke',
      )

    // Fire-and-forget dispatch (non-blocking). We log, not swallow.
    const logDispatchFail = (label) => (err) =>
      serverLogger.warn('smoke.dispatch_failed', { job: label, error: err?.message || String(err) })
    dispatchCrawlerJob({ db, jobId: comprehensiveJobId, uploadDir: uploadsDir, getOpenAI: null }).catch(logDispatchFail('comprehensive'))
    dispatchCrawlerJob({ db, jobId: scholarshipJobId, uploadDir: uploadsDir, getOpenAI: null }).catch(logDispatchFail('scholarship'))
    dispatchCrawlerJob({ db, jobId: documentIngestJobId, uploadDir: uploadsDir, getOpenAI: null }).catch(logDispatchFail('documentIngest'))
  } catch (error) {
    console.warn('[smoke] Failed to schedule crawler smoke jobs:', error?.message || String(error))
  }
}

async function scheduleAutoProfileDedupe({ db }) {
  // Goal: delete duplicate profiles automatically without requiring a human to click buttons.
  // This runs once per deployed SHA and is intentionally conservative.
  if (process.env.NODE_ENV !== 'production') return
  if (!db) return

  const sha = resolveBuildSha()
  const runId = sha ? `auto-dedupe-${String(sha).slice(0, 12)}` : `auto-dedupe-${crypto.randomUUID().slice(0, 12)}`
  console.info('[auto-dedupe] starting', { runId, sha: sha ? String(sha).slice(0, 12) : null })

  // Skip if we already ran on this deploy SHA (best-effort via audit_logs).
  try {
    const exists = await db
      .prepare(
        `
          SELECT 1
          FROM audit_logs
          WHERE category = 'admin'
            AND action = 'auto_profile_dedupe'
            AND resource_id = ?
          LIMIT 1
        `,
      )
      .get(runId)
    if (exists) {
      console.info('[auto-dedupe] already ran for this deploy; skipping', { runId })
      return
    }
  } catch {
    // audit_logs may not exist yet; proceed.
  }

  const startedAt = Date.now()
  let mergedGroups = 0
  let mergedLosers = 0
  let skippedGroups = 0

  try {
    const strategies = ['similar_name', 'exact_name']

    for (const strategy of strategies) {
      const report = await findDuplicateProfileGroups(db, {
        strategy,
        limitGroups: 500,
        minGroupSize: 2,
        includeInactive: false,
      })

      for (const group of report?.groups || []) {
      const winner = group?.winner
      const losers = Array.isArray(group?.losers) ? group.losers : []
      if (!winner?.id || losers.length === 0) continue

      // Safety: skip if multiple distinct non-null users or organizations are involved.
      const userIds = new Set([winner.user_id, ...losers.map((l) => l.user_id)].filter(Boolean).map(String))
      const orgIds = new Set([winner.organization_id, ...losers.map((l) => l.organization_id)].filter(Boolean).map(String))
      if (userIds.size > 1 || orgIds.size > 1) {
        skippedGroups += 1
        console.info('[auto-dedupe] skipped group (conflicting links)', {
          runId,
          key: group.key,
          winnerId: winner.id,
          loserCount: losers.length,
          userIds: Array.from(userIds),
          orgIds: Array.from(orgIds),
        })
        logAuditEvent(db, {
          category: AUDIT_CATEGORIES.ADMIN,
          action: 'auto_profile_dedupe_skipped',
          severity: SEVERITY.WARNING,
          resourceType: 'profile',
          resourceId: winner.id,
          details: {
            run_id: runId,
            group_key: group.key,
            reason: 'conflicting user_id and/or organization_id across group',
            user_ids: Array.from(userIds),
            organization_ids: Array.from(orgIds),
            winner_id: winner.id,
            loser_ids: losers.map((l) => l.id),
          },
        })
        continue
      }

      const loserIds = losers.map((l) => l.id).filter(Boolean)
      try {
        await mergeProfiles(db, {
          winnerId: winner.id,
          loserIds,
          dryRun: false,
          actorUserId: null,
        })
        mergedGroups += 1
        mergedLosers += loserIds.length
        console.info('[auto-dedupe] merged group', { runId, key: group.key, winnerId: winner.id, loserCount: loserIds.length })
        logAuditEvent(db, {
          category: AUDIT_CATEGORIES.ADMIN,
          action: 'auto_profile_merge',
          severity: SEVERITY.INFO,
          resourceType: 'profile',
          resourceId: winner.id,
          details: { run_id: runId, group_key: group.key, winner_id: winner.id, loser_ids: loserIds },
        })
      } catch (mergeError) {
        skippedGroups += 1
        console.warn('[auto-dedupe] merge failed', {
          runId,
          key: group.key,
          winnerId: winner.id,
          loserCount: loserIds.length,
          error: mergeError?.message || String(mergeError),
        })
        logAuditEvent(db, {
          category: AUDIT_CATEGORIES.ADMIN,
          action: 'auto_profile_merge_failed',
          severity: SEVERITY.ERROR,
          resourceType: 'profile',
          resourceId: winner.id,
          details: {
            run_id: runId,
            group_key: group.key,
            winner_id: winner.id,
            loser_ids: loserIds,
            error: mergeError?.message || String(mergeError),
          },
        })
      }
      }
    }
  } finally {
    logAuditEvent(db, {
      category: AUDIT_CATEGORIES.ADMIN,
      action: 'auto_profile_dedupe',
      severity: SEVERITY.INFO,
      resourceType: 'system',
      resourceId: runId,
      details: {
        sha: sha || null,
        merged_groups: mergedGroups,
        merged_losers: mergedLosers,
        skipped_groups: skippedGroups,
        duration_seconds: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
      },
    })
    console.info('[auto-dedupe] finished', {
      runId,
      mergedGroups,
      mergedLosers,
      skippedGroups,
      durationSeconds: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
    })
  }
}

// Build metadata endpoint (public, no secrets)
// NOTE: This endpoint is used to confirm production is on the expected commit.
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
app.use('/api/admin/funding-trace', lazyRouter('./routes/fundingTrace.js'));
app.use('/api/admin/agent-telemetry', lazyRouter('./routes/agentTelemetry.js'));
// Admin Agent Control Center — start/stop/pause/resume/emergency-stop the
// whole agent process. Restricted to the canonical operator
// (buckeye7066@gmail.com or AGENT_CONTROL_ADMIN_EMAIL env override).
app.use('/api/admin/agent-control', lazyRouter('./routes/adminAgentControl.js'));
app.use('/api', requestTimeout(PIPELINE_TIMEOUT), discoveryRouter);
app.use('/api/crawler-v2', lazyRouter('./routes/crawlerV2.js'));
app.use('/api/nf-programs', lazyRouter('./routes/nfPrograms.js'));

// Pipeline stats
app.get('/api/pipeline/stats', async (req, res) => {
  try {
    const rows = await db.prepare(`
      SELECT status, COUNT(*) as count
      FROM grants
      GROUP BY status
    `).all();

    // Bucket every grant into the canonical 11 pipeline stages via the single
    // source of truth (shared/pipelineStages.js). This fixes the previous
    // hand-rolled map that (a) mislabeled `archived`/`closed` grants as
    // `rejected` and (b) had a dead `submission_ready` bucket that nothing
    // mapped into. canonicalStage() resolves every legacy alias.
    const { PIPELINE_STAGES, canonicalStage } = await import('../shared/pipelineStages.js');
    const canonical = Object.fromEntries(PIPELINE_STAGES.map((s) => [s, 0]));
    rows.forEach((row) => {
      const stage = canonicalStage(row.status);
      if (stage && canonical[stage] !== undefined) {
        canonical[stage] += Number(row.count ?? 0);
      }
    });

    // Backward-compatible aliases for existing dashboard cards (legacy keys map
    // to the right canonical counts — `rejected` now means declined ONLY, so
    // archived grants are no longer miscounted as rejected).
    res.json({
      ...canonical,
      app_prep: canonical.gathering_documents,
      submission_ready: canonical.ready_to_submit,
      rejected: canonical.declined,
    });
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
    const loggedCorsOrigins = Array.isArray(corsOptions.origin) ? corsOptions.origin : [corsOptions.origin];
    console.log(`CORS origins: ${loggedCorsOrigins.join(', ')}`);
    const actualPort = server.address()?.port ?? PORT;
    console.log(`[Server] Ready on port ${actualPort}`);

    // Robert — funding-discovery agent scheduler. Disabled by default; only
    // starts if ROBERT_ENABLED and one of ROBERT_RUN_ON_SCHEDULE/STARTUP or
    // ROBERT_AUTOSEED_ON_SCHEDULE (funding-trace weak-coverage sweep) is true.
    ;(async () => {
      try {
        const { startRobertScheduler } = await import('./services/robert/robertScheduler.js')
        const result = startRobertScheduler({ db })
        if (result?.started) console.log('[Server] Robert scheduler started')
        else console.log('[Server] Robert scheduler not started:', result?.reason || 'disabled')
      } catch (err) {
        console.warn('[Server] Robert scheduler startup skipped:', err?.message)
      }
    })();
    // Yana — client-discovery agent scheduler. Disabled by default; only
    // starts if YANA_ENABLED + YANA_RUN_ON_SCHEDULE/STARTUP are true. Runs the
    // deterministic lead funnel in the background regardless of login.
    ;(async () => {
      try {
        const { startYanaScheduler } = await import('./services/yana/yanaScheduler.js')
        const result = startYanaScheduler({ db })
        if (result?.started) console.log('[Server] Yana scheduler started')
        else console.log('[Server] Yana scheduler not started:', result?.reason || 'disabled')
      } catch (err) {
        console.warn('[Server] Yana scheduler startup skipped:', err?.message)
      }
    })();
    // Sam scheduler — opt-in via SAM_ENABLED + SAM_RUN_ON_STARTUP /
    // SAM_RUN_ON_SCHEDULE. Default behaviour is OFF; the scheduler logs
    // once and exits when env gates aren't set.
    (async () => {
      try {
        const { startSamScheduler } = await import('./services/sam/samScheduler.js')
        startSamScheduler({ db, logger: console })
      } catch (samErr) {
        console.warn('[sam:scheduler] failed to start:', samErr?.message || samErr)
      }
    })();

    // Auto-heal Postgres CHECK constraints that may be outdated if migrations haven't run.
    if (db.dialect === 'postgres') {
      (async () => {
        try {
          await db.exec(`
            ALTER TABLE funding_opportunities
              DROP CONSTRAINT IF EXISTS funding_opportunities_record_origin_check;
            ALTER TABLE funding_opportunities
              ADD CONSTRAINT funding_opportunities_record_origin_check
              CHECK (${allowedOriginCheckSQL()});
          `)
          console.log('[startup] record_origin CHECK constraint verified/expanded')
        } catch (e) {
          console.warn('[startup] record_origin constraint fix skipped:', e?.message)
        }

        try {
          // Generate the CHECK list from GRANT_STATUSES (config/constants.js → shared/pipelineStages.js)
          // so the live constraint can never drift from the constant the API/UI validate against.
          const grantStatusList = GRANT_STATUSES.map((s) => `'${s}'`).join(',')
          await db.exec(`
            ALTER TABLE grants DROP CONSTRAINT IF EXISTS grants_status_check;
            ALTER TABLE grants ADD CONSTRAINT grants_status_check CHECK (status IN (${grantStatusList}));
          `)
          console.log('[startup] grants status CHECK constraint verified/expanded')
        } catch (e) {
          console.warn('[startup] grants status constraint fix skipped:', e?.message)
        }
      })()
    }

    // John — Outreach Drafting Agent. Disabled by default; only starts a
    // scheduler if JOHN_ENABLED=true and JOHN_RUN_ON_SCHEDULE=true (or
    // JOHN_RUN_ON_STARTUP=true). Never blocks startup, never crashes the
    // server on failure. Draft-only; never sends.
    ;(async () => {
      try {
        const { startJohnScheduler } = await import('./services/john/johnScheduler.js')
        const result = startJohnScheduler({ db })
        if (result?.started) console.log('[Server] John scheduler started:', JSON.stringify(result))
        else console.log('[Server] John scheduler not started:', result?.reason || 'disabled')
      } catch (err) {
        console.warn('[Server] John scheduler startup skipped:', err?.message)
      }
    })();

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

    // Larry — Lead Discovery & Outreach Agent. Off by default; the scheduler
    // is a no-op unless LARRY_ENABLED=true and at least one of
    // LARRY_RUN_ON_STARTUP / LARRY_RUN_ON_SCHEDULE is true.
    ;(async () => {
      try {
        const { startLarryScheduler } = await import('./services/larry/larryScheduler.js')
        const result = startLarryScheduler({ db })
        if (result?.started) console.log('[Server] Larry scheduler started')
        else console.log('[Server] Larry scheduler not started:', result?.reason || 'disabled')
      } catch (err) {
        console.warn('[Server] Larry scheduler startup skipped:', err?.message)
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
          dispatchCrawlerJob({ db: dbRef, jobId: queued[i].id, uploadDir: uploadsDirRef, getOpenAI: null }).catch((err) =>
            serverLogger.warn('startup_drain.dispatch_failed', { jobId: queued[i].id, error: err?.message })
          )
        } catch (err) {
          /* intentionally non-fatal: individual dispatch errors must not abort the drain loop */
          serverLogger.debug('startup_drain.dispatch_threw', { jobId: queued[i].id, error: err?.message })
        }
      }
    }

    if (BACKGROUND_SERVICES_DISABLED) {
      console.log('[startup] Background queue poller disabled for smoke/test startup')
    } else if (queuePollEnabled) {
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
              dispatchCrawlerJob({ db, jobId: job.id, uploadDir: uploadsDir, getOpenAI: null }).catch((err) =>
                serverLogger.warn('queue_poller.dispatch_failed', { jobId: job.id, error: err?.message })
              )
            } catch (err) {
              /* intentionally non-fatal: individual dispatch errors must not break the poll cycle */
              serverLogger.debug('queue_poller.dispatch_threw', { jobId: job.id, error: err?.message })
            }
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

    // ── Startup self-check: verify the matching pipeline can score ──
    (async () => {
      try {
        const { trustedOriginClause, trustedSourceClause } = await import('./utils/recordOrigins.js')
        const activeVal = db.dialect === 'postgres' ? 'TRUE' : '1'
        const count = await db.prepare(`
          SELECT COUNT(*) AS n FROM funding_opportunities
          WHERE is_active = ${activeVal} AND ${trustedOriginClause()} AND ${trustedSourceClause()}
        `).get()
        const n = Number(count?.n ?? 0)
        if (n === 0) {
          console.warn('[startup][WARN] 0 active trusted funding opportunities — users will see no matches')
        } else {
          console.log(`[startup] ${n} active trusted funding opportunities ready for matching`)
        }
      } catch (err) {
        console.error('[startup] Pipeline self-check failed:', err?.message || err)
      }
    })()

    // Expose a stable in-process base URL for Anya autonomous function tests.
    // NOTE: When PORT=0 (ephemeral), the actual listening port differs from process.env.PORT.
    try {
      globalThis.__grantflow_internal_base_url = `http://127.0.0.1:${actualPort}`
    } catch {
      // best-effort only
    }

    if (IS_SMOKE_MODE) {
      console.info('[startup] Smoke mode: skipping background services')
      return
    }
  
  // Initialize feature flags
  try {
    initializeFeatureFlags(db);
    console.log('[FeatureFlags] Initialized successfully');
  } catch (err) {
    console.warn('[FeatureFlags] Failed to initialize:', err.message);
  }

  if (BACKGROUND_SERVICES_DISABLED) {
    console.info('[startup] Background services disabled for smoke/test startup')
  } else {
    // Startup smoke crawlers (PRODUCTION): default OFF.
    // These are useful for deploy verification, but must not run automatically unless explicitly enabled.
    const startupSmokeEnabled = parseBoolEnv(process.env.STARTUP_SMOKE_CRAWL_ENABLED) === true
    if (startupSmokeEnabled) {
      setTimeout(() => {
        scheduleCrawlerSmokeJobs({ db, uploadsDir }).catch((err) =>
          serverLogger.warn('smoke.schedule_failed', { error: err?.message || String(err) }),
        )
      }, 10_000)
      console.info('[startup] Startup smoke crawlers enabled (STARTUP_SMOKE_CRAWL_ENABLED=true)')
    } else {
      console.info(
        '[startup] Startup smoke crawlers disabled (set STARTUP_SMOKE_CRAWL_ENABLED=true to enable)',
      )
    }

    // Auto-merge duplicate profiles once per deploy (production only).
    setTimeout(() => {
      scheduleAutoProfileDedupe({ db }).catch((err) => {
        console.warn('[auto-dedupe] failed:', err?.message || String(err))
      })
    }, 20_000)
  }
  
  // Log server startup event
  logAuditEvent(db, {
    category: AUDIT_CATEGORIES.SYSTEM,
    action: 'server_startup',
    severity: SEVERITY.INFO,
    details: {
      port: actualPort,
      environment: process.env.NODE_ENV || 'development',
      corsOrigins: loggedCorsOrigins,
    },
  }).catch((err) => {
    /* intentionally non-fatal: startup audit log must not block server boot */
    serverLogger.debug('audit.server_startup_log_failed', { error: err?.message || String(err) })
  });
  
  // Start Anya autonomous operations 5 seconds after server is ready.
  if (BACKGROUND_SERVICES_DISABLED) {
    console.log('[Anya] Startup operations disabled for smoke/test startup')
  } else if (process.env.ANYA_AUTONOMOUS_ENABLED === 'true') {
    setTimeout(() => {
      if (process.env.ANYA_RUN_ON_STARTUP === 'true') {
        import('./services/anyaAutonomousScheduler.js')
          .then(({ runOnStartup }) => {
            console.log('[Anya] Starting autonomous operations on server startup...');
            runOnStartup(db).catch(err => {
              console.error('[Anya] Failed to complete autonomous operations:', err);
            });
          })
          .catch((err) => {
            console.error('[Anya] Failed to import autonomous scheduler:', err?.message || err);
          });
      } else {
        runStartupOperations(db).catch(err => {
          console.error('[Anya] Failed to complete crawler operations:', err);
        });
      }
    }, 5000);

    // Wire up the scheduled runner (e.g. daily at 3 AM).
    // checkSchedule is a lightweight hour-check; call it every 30 minutes.
    if (process.env.ANYA_RUN_ON_SCHEDULE === 'true') {
      const SCHEDULE_CHECK_MS = 30 * 60 * 1000
      setInterval(() => {
        import('./services/anyaAutonomousScheduler.js')
          .then(({ checkSchedule }) => {
            checkSchedule(db).catch(err => {
              console.error('[Anya] Scheduled check failed:', err?.message || err);
            });
          })
          .catch((err) => {
            /* intentionally non-fatal: scheduler import failure must not crash the interval */
            serverLogger.debug('anya.scheduler_import_failed', { error: err?.message || String(err) })
          });
      }, SCHEDULE_CHECK_MS);
      console.log('[Anya] Scheduled runner enabled (checking every 30 min)');
    }
  } else {
    // Even without autonomous operations, run basic startup crawlers
    setTimeout(() => {
      runStartupOperations(db).catch(err => {
        console.error('[Anya] Failed to complete crawler operations:', err);
      });
    }, 5000);
    console.log('[Anya] Autonomous operations disabled — running basic startup crawlers only');
  }

  // Daily profile-aware auto-discovery (independent of ANYA_AUTONOMOUS_*).
  if (!BACKGROUND_SERVICES_DISABLED && process.env.AUTO_DISCOVERY_DAILY_ENABLED === 'true') {
    const SCHEDULE_CHECK_MS = 30 * 60 * 1000;
    setInterval(() => {
      import('./services/scheduledAutoDiscovery.js')
        .then(({ checkScheduledAutoDiscovery }) => {
          checkScheduledAutoDiscovery(db, { uploadDir: uploadsDir, getOpenAI: null }).catch((err) => {
            console.error('[scheduled-auto-discovery] Scheduled check failed:', err?.message || err);
          });
        })
        .catch((err) => {
          serverLogger.debug('scheduled_auto_discovery.import_failed', { error: err?.message || String(err) });
        });
    }, SCHEDULE_CHECK_MS);
    console.log('[scheduled-auto-discovery] Daily profile-aware discovery enabled (checking every 30 min)');
  }

  // Deadline expiry + notification cron (runs daily at 2am, and once at startup after 5s delay).
  // Marks opportunities with passed deadlines as inactive and generates approaching-deadline notifications.
  async function runDeadlineCron() {
    try {
      const expiryResult = await expirePassedDeadlines(db)
      console.info('[deadline-cron] Expiry run complete', expiryResult)
    } catch (err) {
      console.error('[deadline-cron] Expiry failed:', err?.message || err)
    }
    try {
      const notifResult = await generateDeadlineNotifications(db)
      console.info('[deadline-cron] Notification run complete', notifResult)
    } catch (err) {
      console.error('[deadline-cron] Notifications failed:', err?.message || err)
    }
  }

  if (BACKGROUND_SERVICES_DISABLED) {
    console.info('[deadline-cron] Disabled for smoke/test startup')
  } else {
    // Run once at startup (5s delay to let the DB settle).
    setTimeout(() => {
      runDeadlineCron().catch((err) => {
        console.error('[deadline-cron] Startup run failed:', err?.message || err)
      })
    }, 5000)

    // Run daily at 2am: check every 60s whether it's time to run.
    // This avoids needing a real cron daemon while still running close to 2am.
    ;(function scheduleDailyDeadlineCron() {
      let lastRunDate = null
      const DAILY_CRON_INTERVAL_MS = 60 * 1000 // check every minute

      const handle = setInterval(() => {
        const now = new Date()
        const todayStr = now.toISOString().slice(0, 10)
        // Run at 2am (hours === 2) and only once per calendar day.
        if (now.getHours() === 2 && lastRunDate !== todayStr) {
          lastRunDate = todayStr
          runDeadlineCron().catch((err) => {
            console.error('[deadline-cron] Daily run failed:', err?.message || err)
          })
        }
      }, DAILY_CRON_INTERVAL_MS)

      process.once('SIGTERM', () => clearInterval(handle))
      process.once('SIGINT', () => clearInterval(handle))
      console.info('[deadline-cron] Daily deadline cron scheduled (runs at 2am)')
    })()
  }

  // Run link verification in background (non-blocking).
  //
  // Mission rule: a "verified" opportunity must have actually been verified.
  // The recurring verifier owns ongoing freshness, including expiring stale
  // direct opportunities that have not been confirmed reachable in 90 days.
  //
  // Tunable via env:
  //   LINK_VERIFICATION_INTERVAL_MS (default 6h)
  //   LINK_VERIFICATION_BATCH      (default 200)
  async function scheduleLinkVerification(dbInstance) {
    const intervalMs = Math.max(
      30 * 60 * 1000,
      Number(process.env.LINK_VERIFICATION_INTERVAL_MS) || 6 * 60 * 60 * 1000,
    )
    const limit = Math.max(10, Number(process.env.LINK_VERIFICATION_BATCH) || 200)
    const runOnce = async () => {
      try {
        const stats = await runLinkVerification(dbInstance, {
          limit,
          verifiedBy: `recurring-verifier:pid=${process.pid}`,
        })
        console.log('[link-verify] completed:', stats)
      } catch (err) {
        console.warn('[link-verify] failed:', err.message)
      }
    }
    // Run once at startup after a 30s delay, then on the configured interval.
    setTimeout(runOnce, 30_000)
    setInterval(runOnce, intervalMs)
  }
  if (BACKGROUND_SERVICES_DISABLED) {
    console.info('[startup] Link verification, health service, and Anya cleanup disabled for smoke/test startup')
  } else {
    scheduleLinkVerification(db)

    // Start the background health service (runs every 30 min, configurable via ANYA_HEALTH_INTERVAL_MS)
    startHealthService(db);

    // Daily Anya brain/tool-usage cleanup (keeps the memory + audit tables bounded).
    import('./jobs/anyaBrainCleanup.js')
      .then(({ startAnyaBrainCleanupCron }) => startAnyaBrainCleanupCron({ db }))
      .catch((err) => console.warn('[anyaBrainCleanup] failed to start:', err?.message || err));
  }

  // Group 7: persist warn/error logs to audit_logs so admin.health.logs
  // survives process restarts. The logger ring buffer stays in-memory; this
  // sink writes durably in the background. We drop records silently on
  // failure to avoid crashing request handlers.
  try {
    setAuditLogSink((rec) => {
      const severity = rec.level === 'error' ? 'error' : 'warn'
      // Don't block the emit site; fire-and-forget.
      setImmediate(async () => {
        try {
          const id = (await import('crypto')).randomUUID()
          await db
            .prepare(
              `INSERT INTO audit_logs (id, category, action, severity, details)
                 VALUES (?, ?, ?, ?, ?)`,
            )
            .run(
              id,
              'logger',
              String(rec.namespace || 'app') + ':' + String(rec.event || 'log'),
              severity,
              String(rec.message || '').slice(0, 4000),
            )
        } catch {
          // swallow; a logging path must never crash the server
        }
      })
    })
  } catch (err) {
    console.warn('[logger] setAuditLogSink failed:', err?.message || err)
  }

  // Group 5: Verify the Anya tool registry is collision-free at boot. Duplicate
  // tool ids used to silently override each other; now we fail loudly during
  // startup so the server never ships with an ambiguous registry.
  import('./services/anyaToolRegistry.js')
    .then(({ assertNoDuplicateToolIds }) => {
      try {
        const n = assertNoDuplicateToolIds()
        console.log(`[anyaToolRegistry] boot verify: ${n} tools registered, no duplicates.`)
      } catch (err) {
        console.error('[anyaToolRegistry] boot verify FAILED:', err?.message || err)
        if (process.env.NODE_ENV === 'production') {
          process.exit(1)
        }
      }
    })
    .catch((err) => console.warn('[anyaToolRegistry] verify import failed:', err?.message || err));

  // Optional: continuous national programs crawler (Track A/B programs)
  if (!BACKGROUND_SERVICES_DISABLED && process.env.NATIONAL_PROGRAMS_CRAWLER_ENABLED === 'true') {
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
  } else if (!BACKGROUND_SERVICES_DISABLED) {
    console.log(
      '[NationalPrograms] Continuous crawler disabled (set NATIONAL_PROGRAMS_CRAWLER_ENABLED=true to enable)',
    )
  }

  // Start Anya background health service
  if (!BACKGROUND_SERVICES_DISABLED) {
    try {
      startHealthService(db)
    } catch (err) {
      console.error('[AnyaHealth] Failed to start health service:', err?.message || err)
    }
  }

  // Validate critical module imports (non-blocking).
  // Runs after the server is listening so it doesn't delay startup.
  // Results are available at GET /api/health/imports for admin diagnostics.
  validateCriticalImports().catch((err) => {
    console.error('[startup] Import validation failed unexpectedly:', err?.message || err)
  })
  });
} else {
  console.info('[server] NODE_ENV=test; HTTP listener disabled')
}

export default app;
