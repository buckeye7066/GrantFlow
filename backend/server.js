// Load `.env` from the current working directory. Use override so `.env` wins over any stale
// machine-level OPENAI_API_KEY values during local development.
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { createLogger, setAuditLogSink } from './utils/logger.js';
import { flushObservability, initObservability } from './utils/observability.js';

const serverLogger = createLogger('server');
initObservability();
import fs from 'fs';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import { safeTokenEqual } from './utils/safeTokenEqual.js';
import { responseEnvelope } from './utils/responseEnvelope.js';
import { db } from './db/index.js';
import { CANONICAL_ADMIN_EMAIL_DEFAULT } from './services/agentControl/agentControlTypes.js';

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
import { maintenanceGuard } from './services/maintenance/maintenanceMode.js';
const maintenanceGuardMw = maintenanceGuard();
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
// Shared DST-correct ET wall-clock helpers for the in-process schedulers below.
// CRITICAL: these clamp Node 20's ICU midnight quirk (hour "24" with
// hour12:false). The previous inline copies read hour 24 during 00:00–00:59 ET,
// which is ≥ any trigger hour, so a tick landing in that hour fired the whole
// day's jobs at midnight (observed in prod: Sam's 05:00 sweep + Anya's 09:00
// owner email both ran at ~00:05 ET after a midnight deploy).
import { etNowParts, eligibleDayKey as etEligibleDayKey, eligibleWeekKey as etEligibleWeekKey } from './utils/etTime.js'
import { runStartupOperations } from './services/anyaStartupOperations.js';
import { startHealthService } from './services/anyaHealthService.js';
import ensureMinimumNationalOpportunities from './utils/ensureMinimumNationalOpportunities.js';
import seedAssistanceDirectories from './utils/seedAssistanceDirectories.js';
import seedFaithBasedHousing from './utils/seedFaithBasedHousing.js';
import seedHousingFundingOpportunities from './utils/seedHousingFunding.js';
import { errorHandler } from './middleware/errorHandler.js';
import { reportErrorToOwner } from './services/errorReporter.js';
import { profileContextMiddleware } from './middleware/profileContext.js';
import { attachRequestContext, isSyntheticServiceAdmin } from './middleware/requestContext.js';
import { enforceResolvedIdentity } from './middleware/enforceResolvedIdentity.js';
import { ensureAuth, ensureAdmin } from './middleware/auth.js';
import { pipelineMonitor, getPipelineHealth } from './middleware/pipelineMonitor.js';
import { requestTimeout } from './middleware/requestTimeout.js';
import { responseCache } from './middleware/responseCache.js';
import { MAX_JSON_BODY_SIZE, GRANT_STATUSES } from './config/constants.js';
import { getSafeHealthSummary } from './services/diagnosticsService.js';
import { initializeFeatureFlags } from './services/featureFlagService.js';
import { logAuditEvent, AUDIT_CATEGORIES, SEVERITY } from './services/auditService.js';
import { resolveGuidedCycleTourStatus, resolveForcedWelcomeVideo } from './services/onboardingGates.js';
import { runWithSchedulerLock } from './services/schedulerLock.js';
import { decryptRuntimeSecret } from './utils/runtimeSecrets.js';
import { seedBaselineFromRepo } from './utils/seedBaselineFromRepo.js';
import { assertFundingApiKeys, getFundingApiKeyPresence } from './src/config/apiKeys.js';
import { ensureProfileEmailSchema, buildGrantScopeFromContext, getOwnedAndGrantedProfileIds } from './utils/accessControl.js';
import { dispatchCrawlerJob, startQueueDrainInterval } from './services/crawlerDispatcher.js';
import { cleanupStaleCrawlers, cleanupStaleQueuedJobs } from './services/crawlerConcurrencyGuard.js'
import { findDuplicateProfileGroups, mergeProfiles } from './services/profileDedupeService.js'
import { ORIGIN_CREATED_BY as AMY_ORIGIN_CREATED_BY, METADATA_SECTION_KEY as AMY_METADATA_SECTION_KEY } from './services/amy/amyConstants.js'
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
import { runLinkVerification, getLinkHealthSummary } from './services/linkVerificationService.js'
import { sendEmail, isEmailServiceConfigured } from './services/email.js'
import { runBillingCycle } from './services/billing/invoiceService.js'
import { validateCriticalImports } from './startup/validateImports.js'
import { runGracefulShutdown } from './startup/gracefulShutdown.js'

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
    try {
      if (!_router) {
        const mod = await import(specifier)
        _router = extract ? extract(mod) : (mod.default ?? mod)
      }
    } catch (err) {
      // A lazily-loaded route module failed to import (e.g. a bad import path
      // that only resolves in dev). Previously the rejected promise was swallowed
      // and next() was never called, so EVERY request routed through this mount
      // hung until the gateway 504'd — and for a catch-all '/api' mount that took
      // down every route mounted after it. Fail fast instead: surface the error
      // to Express (→ 500) so the failure is loud, isolated, and never a hang.
      console.error(`[lazyRouter] failed to load ${specifier}:`, err?.message || err)
      return next(err)
    }
    return _router(req, res, next)
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
// The synthetic user materialised when a request authenticates with ADMIN_TOKEN /
// ANYA_ADMIN_TOKEN must carry the canonical operator email so it can pass the
// canonical-admin gate on routers like /api/admin/agent-control/* and any other
// place that uses isControlCenterAdmin() (which compares user.email against
// AGENT_CONTROL_ADMIN_EMAIL || ADMIN_EMAIL || CANONICAL_ADMIN_EMAIL_DEFAULT).
// Without this, server-internal probes (Sam's httpProbe, codeGuard.endpointHealth,
// Hamilton automation checks) presented a valid service token but were still
// rejected with 403 because their synthetic email was the throwaway
// 'admin@grantflow.app' default that nothing else recognises. Trust here is
// unchanged: ADMIN_TOKEN was already accepted as `role:admin, is_admin:true`;
// we are only aligning the email so the canonical-admin check passes.
const ADMIN_EMAIL =
  process.env.AGENT_CONTROL_ADMIN_EMAIL ||
  process.env.ADMIN_EMAIL ||
  CANONICAL_ADMIN_EMAIL_DEFAULT;

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
// Express 5 changed the default query parser from 'extended' (qs) to 'simple'.
// Pin the Express 4 behavior so nested/array query params (?a[b]=1, ?x[]=y)
// keep parsing the way every existing route expects.
app.set('query parser', 'extended');
const PORT = ENV?.PORT ?? process.env.PORT ?? 8080;

function getUploadCacheFileName(req) {
  const reqPath = String(req?.path || '').replace(/^\/+/, '')
  if (!reqPath || reqPath.includes('/')) return null
  return reqPath
}

function isPublicUploadCacheRequest(req) {
  const fileName = getUploadCacheFileName(req)
  if (!fileName) return false
  // User/profile documents and knowledge-base files are private and must go
  // through authenticated download routes. Keep only the profile-avatar disk
  // cache publicly readable so older avatar_url render paths keep working.
  return /^avatar_[A-Za-z0-9_-]+_\d+\.(?:png|jpe?g|webp|gif|bmp|tiff?|heic|heif|ico)$/i.test(fileName)
}

function publicUploadCache(staticMiddleware) {
  return (req, res, next) => {
    if (!isPublicUploadCacheRequest(req)) return next()
    res.setHeader('X-Upload-Access', 'public-avatar-cache')
    return staticMiddleware(req, res, next)
  }
}

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

    if ((missingEnv || !persistentOk || !writableOk) && !allowEphemeralUploads) {
      const reason = missingEnv
        ? 'UPLOADS_DIR is required in production'
        : !persistentOk
          ? `UPLOADS_DIR is not a likely persistent mount: ${uploadsDir}`
          : `UPLOADS_DIR is not writable: ${uploadsDir}`
      console.error('[storage] FATAL: refusing to boot with non-persistent uploads storage', {
        reason,
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

// Disk-usage observability: log volume usage at boot and WARN when the
// persistent volume (/data) crosses the threshold. The volume filling to 100%
// previously crashed prod on every restart; this makes the next fill visible
// BEFORE it crashes. Best-effort — never blocks boot.
try {
  const { checkAndLogDiskUsage } = await import('./services/maintenance/diskUsage.js')
  await checkAndLogDiskUsage({ label: 'boot' })
} catch (diskErr) {
  console.warn('[storage] disk-usage check failed (non-fatal):', diskErr?.message)
}

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

// The Capacitor mobile app (com.grantflow.app) serves the bundled frontend
// from these origins. Always allowed, merged after CORS_ORIGIN so an env
// edit can't silently break mobile login. Auth is Bearer-token, so this
// grants no cookie-based CSRF surface.
const capacitorOrigins = ['https://localhost', 'capacitor://localhost'];

const corsOptions = {
  origin: [...new Set([...(configuredCorsOrigins && configuredCorsOrigins.length > 0 ? configuredCorsOrigins : defaultCorsOrigins), ...capacitorOrigins])],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Token', 'X-Anya-Token', 'X-Profile-Id', 'X-Request-Id'],
};

app.use(cors(corsOptions));
// Express 5: '*' is no longer a valid path (path-to-regexp v8) — '/{*splat}'
// is the equivalent match-everything pattern for CORS preflight.
app.options('/{*splat}', cors(corsOptions));

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

// Standardized JSON response envelope + double-send guard.
// See backend/utils/responseEnvelope.js. Single choke point: error objects
// (HTTP >= 400) get `{ ok: false, request_id, ... }`; success shapes are left
// untouched; a res.json() after the response is committed is a logged no-op
// instead of an unhandled "Cannot set headers after they are sent" rejection.
app.use(responseEnvelope);

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

// Twilio inbound-SMS webhook. Mounted BEFORE express.json() because Twilio POSTs
// application/x-www-form-urlencoded (the router parses its own body) and signs
// the raw request — see backend/routes/smsInbound.js. req.db is already attached.
app.use('/api/sms', lazyRouter('./routes/smsInbound.js'));

app.use(express.json({ limit: MAX_JSON_BODY_SIZE }));

// Mount health check routes EARLY to ensure they're always available
// req.db is already attached above.
app.use(healthRouter);

// IMPORTANT: Missing uploads must return 404 (not SPA index.html).
// Serve both current + legacy upload locations, then terminate with a strict 404.
// User-uploaded files use no-cache so updated files are always re-validated.
app.use('/uploads', publicUploadCache(express.static(uploadsDir, {
  index: false,
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-cache')
  },
})));
try {
  if (legacyUploadsDir !== uploadsDir && fs.existsSync(legacyUploadsDir)) {
    app.use('/uploads', publicUploadCache(express.static(legacyUploadsDir, {
      index: false,
      setHeaders(res) {
        res.setHeader('Cache-Control', 'no-cache')
      },
    })));
  }
} catch {
  // ignore legacy-dir probing failures
}
app.use('/uploads', (req, res) => {
  const reqPath = String(req.path || '').replace(/^\/+/, '')
  const publicCacheRequest = isPublicUploadCacheRequest(req)
  console.warn(publicCacheRequest ? '[uploads] missing public cache file' : '[uploads] private upload blocked', {
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
      error: publicCacheRequest ? 'File not found' : 'Upload is not publicly accessible',
      code: publicCacheRequest ? 'UPLOAD_MISSING' : 'UPLOAD_PRIVATE',
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
  app.use(`${normalizedBase}/uploads`, publicUploadCache(express.static(uploadsDir, { index: false })));
  try {
    if (legacyUploadsDir !== uploadsDir && fs.existsSync(legacyUploadsDir)) {
      app.use(`${normalizedBase}/uploads`, publicUploadCache(express.static(legacyUploadsDir, { index: false })));
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
// Boot policy is centralised in backend/startup/bootPolicy.js so server.js,
// scripts, and tests all reason from the same truth.
const { shouldAutoApplySchema } = await import('./startup/bootPolicy.js')
const shouldAutoMigrate = shouldAutoApplySchema(process.env, db.dialect)

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
//
// IMPORTANT: if the schema apply fails we MUST surface that to /healthz instead
// of swallowing it. Previously a silent failure here could let /healthz return
// 200 while the `users`/`profiles` tables didn't exist, causing race-condition
// CI flakes (e.g. tests/unit/auth-access-check.test.mjs:217 → "no such table:
// users"). Mission rule: "If results are found but not displayed, treat this
// as a bug, not a UX choice" — same applies to a half-bootstrapped DB.
app.locals.schema_bootstrap_failed = false
app.locals.schema_bootstrap_error = null
app.locals.schema_bootstrap_missing_tables = []
if (shouldAutoMigrate) {
  const schemaPath = join(__dirname, 'db', 'schema.sql');
  if (fs.existsSync(schemaPath)) {
    try {
      const schema = fs.readFileSync(schemaPath, 'utf8');
      await db.exec(schema);
      console.info('[database] Schema applied (auto-migrate enabled)', { dialect: db.dialect });
    } catch (schemaError) {
      app.locals.schema_bootstrap_failed = true
      app.locals.schema_bootstrap_error = schemaError?.message || String(schemaError)
      console.error('[database] Error running schema migrations:', schemaError);
      // Do not hard-exit; keep the service reachable for diagnostics.
    }
  } else {
    app.locals.schema_bootstrap_failed = true
    app.locals.schema_bootstrap_error = `schema.sql not found at ${schemaPath}`
    console.error('[database]', app.locals.schema_bootstrap_error)
  }

  // Positive invariant probe: assert every required base table exists. This
  // catches the case where schema.exec succeeded for the first N statements
  // and then silently failed inside a CREATE TABLE we depended on (e.g.
  // `users`), which would otherwise let /healthz return 200 against a DB
  // that's missing critical tables.
  try {
    for (const tbl of validTables) {
      try {
        await db.prepare(`SELECT 1 FROM ${tbl} LIMIT 1`).get()
      } catch (probeErr) {
        const msg = String(probeErr?.message || probeErr).toLowerCase()
        // sqlite: "no such table: X"; postgres: 42P01 'relation "X" does not exist'
        if (msg.includes('no such table') || msg.includes('does not exist')) {
          app.locals.schema_bootstrap_missing_tables.push(tbl)
          app.locals.schema_bootstrap_failed = true
        }
        // Other errors (e.g. permissions) are not bootstrap failures; ignore.
      }
    }
    if (app.locals.schema_bootstrap_missing_tables.length > 0) {
      console.error(
        '[database] Schema bootstrap incomplete; missing tables:',
        app.locals.schema_bootstrap_missing_tables.join(', '),
      )
      if (!app.locals.schema_bootstrap_error) {
        app.locals.schema_bootstrap_error =
          `missing tables: ${app.locals.schema_bootstrap_missing_tables.join(', ')}`
      }
    }
  } catch (probeOuterErr) {
    // Probe machinery itself broke — surface but don't crash.
    console.warn(
      '[database] Schema invariant probe threw (non-fatal):',
      probeOuterErr?.message || probeOuterErr,
    )
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
// tables.
//
// Decision is delegated to backend/startup/bootPolicy.js so this site never has
// to reason about SMOKE_MODE / explicit opt-in/out tokens itself again.
const { shouldMigrateOnBoot: _shouldMigrateOnBoot } = await import('./startup/bootPolicy.js')
const shouldMigrateOnBoot = _shouldMigrateOnBoot(process.env)
if (shouldMigrateOnBoot && !app.locals.db_startup_error) {
  try {
    const { runPendingMigrationsOnBoot } = await import('./db/migrate.js')
    await runPendingMigrationsOnBoot({ logger: console })
  } catch (bootMigrateErr) {
    console.error('[migrate:boot] failed:', bootMigrateErr?.message || bootMigrateErr)
  }
}

// Schema invariants. Single call site that runs every boot-time DDL
// fix-up (agent subsystem, funding reality-gate columns, application_tasks
// CHECK, organizations soft-delete, crawler_jobs.type CHECK,
// anya_match_suggestions, matching_low_coverage_events,
// funding_opportunities verification columns). Each step has its own
// per-step try/catch so one failure cannot mask another. Replaces seven
// inline self-heal blocks that previously lived in this file.
if (!app.locals.db_startup_error) {
  try {
    const { ensureSchemaInvariants } = await import('./startup/ensureSchemaInvariants.js')
    await ensureSchemaInvariants(db, { logger: console })
  } catch (schemaInvariantsErr) {
    // ensureSchemaInvariants is itself wrapped per-step, so an outer throw
    // here means the import or top-level orchestrator broke — log and
    // continue, the server must still start for diagnostics.
    console.warn(
      '[schema-invariants] orchestrator threw (non-fatal):',
      schemaInvariantsErr?.message || schemaInvariantsErr,
    )
  }

  // DATA-repair invariants — the boot "net" documented in CLAUDE.md /
  // canonical_rules.md (sticky deletes, no cross-profile bleed, relevance floor,
  // profile-scoped pipeline, name-doubling, income reconciliation). Sibling to
  // ensureSchemaInvariants above (which owns schema DDL only).
  //
  // BUG FIX: this net was only ever reachable from runSelfHeal(), which is defined
  // in startup/selfHeal.js but NEVER called anywhere — so the data invariants have
  // not actually run at boot in prod despite the docs claiming "step 9 on every
  // boot". Wire it here directly. runEnforceInvariants is internally per-step
  // guarded + idempotent; wrap the orchestrator too so the server still starts.
  // DEFERRED UNTIL AFTER app.listen() — see runBootInvariantSweep() below.
  //
  // This used to `await` here, ~1900 lines before the server binds a port. The
  // sweep is not a schema gate: it is ~20 data-repair passes, several of which do
  // NETWORK I/O (the amount sweep spends a 20s budget on grants.gov API calls,
  // URL rescue spends 20s on web searches, John's draft purge calls Microsoft
  // Graph). All of that ran BEFORE the app could answer a single request.
  //
  // Railway healthchecks `/readyz` with `healthcheckTimeout: 300`. While nothing
  // is listening the edge cannot reach the app at all, so the probe gets a 502 —
  // not the honest 503 `/readyz` would return — and once boot outran the deadline
  // Railway declared the deployment CRASHED and emailed the owner, even though
  // the service came up fine moments later. Six deploys on 2026-07-16 produced
  // exactly that (observed live: `healthz=200` while `readyz=502`).
  //
  // Nothing about these repairs needs to gate traffic: every step is idempotent,
  // individually guarded, and explicitly non-fatal. Migrations still block listen
  // (serving reads against an unmigrated schema WOULD be wrong) — the sweep does
  // not have to.
  const runBootInvariantSweep = async () => {
    try {
      const { runEnforceInvariants } = await import('./startup/enforceInvariants.js')
      const summary = await runEnforceInvariants(db, { logger: console })
      if (summary?.totalRepaired) {
        console.info('[enforce-invariants] boot sweep repaired rows', {
          ran: summary.ran, failed: summary.failed, totalRepaired: summary.totalRepaired,
        })
      }
    } catch (enforceErr) {
      console.warn(
        '[enforce-invariants] orchestrator threw (non-fatal):',
        enforceErr?.message || enforceErr,
      )
    }
  }
  app.locals.runBootInvariantSweep = runBootInvariantSweep
  app.locals.runQualifiedPipelinePromotion = async () => {
    try {
      const { runScheduledQualifiedPipelinePromotion } = await import('./services/pipelinePromotion.js')
      return await runScheduledQualifiedPipelinePromotion(db, { source: 'post-listen', logger: console })
    } catch (err) {
      console.warn('[pipeline-promotion] post-listen run failed (non-fatal):', err?.message || err)
      return null
    }
  }

  // Register the lead sources John drafts outreach from (johnYanaBridge now
  // aggregates over MULTIPLE sources). Yana = Client Discoverer; Robert hands
  // over the subset of contactable client prospects he encounters (never his
  // funding sources — those continue to flow to profiles unchanged).
  try {
    const [{ registerLeadSource }, { makeYanaLeadSource }, { makeRobertLeadSource }] = await Promise.all([
      import('./services/john/johnYanaBridge.js'),
      import('./services/yana/yanaLeadDiscovery.js'),
      import('./services/robert/robertJohnBridge.js'),
    ])
    registerLeadSource(makeYanaLeadSource(db))
    registerLeadSource(makeRobertLeadSource(db))
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
  // Postgres-specific schema invariants (organizations soft-delete columns,
  // crawler_jobs.type CHECK, anya_match_suggestions, etc.) are applied by
  // ensureSchemaInvariants() above, so we only log the dialect skip here.
  console.info('[database] Skipping legacy column auto-migrations (dialect !== sqlite)');
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

// Smoke mode (explicit + inferred) is decided in
// backend/startup/bootPolicy.js so the policy is testable without
// booting the server. Inferred smoke covers the unit-test pattern
// of PORT=0 + DB_AUTO_MIGRATE=true + NODE_ENV != 'production'.
const { isSmokeMode: _isSmokeMode } = await import('./startup/bootPolicy.js')
const IS_SMOKE_MODE = _isSmokeMode(process.env, PORT)

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
      // serviceToken PROVENANCE: set ONLY inside a safeTokenEqual service-token
      // branch. isSyntheticServiceAdmin REQUIRES it, so a JWT whose `sub` collides
      // with a synthetic id (system_admin_token) can never be treated as a service
      // admin (a JWT payload cannot set this flag).
      serviceToken: true,
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
      serviceToken: true,
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
          serviceToken: true,
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
          serviceToken: true,
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
            // Provenance: DB-verified legacy profile bearer TOKEN (non-prod,
            // opt-in), NOT a JWT claim. Only this flag lets getAccessibleProfileIds
            // treat the profileId as access proof.
            profileTokenAuth: true,
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
// Restricted to the VALIDATED synthetic service tokens — gating on the raw
// role:'admin' claim would mint an is_admin=true row from any signed JWT.
app.use(async (req, _res, next) => {
  const user = req.user
  if (!isSyntheticServiceAdmin(user) || !user.userId) return next()

  try {
    const adminEmail = String(user.email || ADMIN_EMAIL || '').trim().toLowerCase() || null
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
      const existingByEmail = adminEmail
        ? await db
            .prepare(
              `
                SELECT id
                FROM users
                WHERE LOWER(TRIM(primary_email)) = ?
                LIMIT 1
              `,
            )
            .get(adminEmail)
        : null

      if (existingByEmail?.id) {
        await db
          .prepare(
            `
              UPDATE users
              SET is_admin = TRUE
              WHERE id = ?
            `,
          )
          .run(existingByEmail.id)
        req.user.userId = existingByEmail.id
        return next()
      }

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
          adminEmail,
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

// STRUCTURAL fail-closed identity gate: for a request whose identity did NOT
// resolve to a trusted principal (deleted-user JWT / synthetic-id collision) and
// which is not an admin, NULL the caller id on both ctx and req.user so no
// user-scoped route can authorize/scope on a stale/reserved id. Runs BEFORE
// profileContext so the SQL tenant context also sees the nulled identity.
app.use(enforceResolvedIdentity());

// Wrap route handlers in an AsyncLocalStorage profile context after auth and
// request context are known, so SQL tenant guards see the real user/profile.
app.use(profileContextMiddleware());

// Health check with dependency checks
// Health check endpoint (v3.0 - complete county data)

// Authentication diagnostics endpoint (admin-only; exposes operational config state).
app.get('/api/auth/diagnostics', ensureAuth, ensureAdmin, async (req, res) => {
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

    // /api/auth/* is exempt from the enforceResolvedIdentity structural gate
    // (identity-ESTABLISHING endpoints must run pre-identity), so req.user is NOT
    // guest-nulled here. But GET /api/auth/me is a user-scoped READ: a deleted-
    // user JWT or a synthetic-id collision JWT (userId=system_admin_token, no
    // serviceToken) would otherwise read the self-healed reserved row and get a
    // 200 user payload. Require a DB-resolved identity (or DB-backed admin), and
    // source the user id from req.ctx.userId — NEVER the raw JWT claim.
    if (req.ctx?.identityResolved !== true && req.ctx?.isAdmin !== true) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const resolvedUserId = req.ctx?.userId ?? null;

    if (resolvedUserId) {
      // Downstream self-heal + response echo read user.userId; pin it to the
      // ctx-resolved id so no raw token claim is trusted below this point.
      user.userId = resolvedUserId;
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
          .get(resolvedUserId);
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
        // Gate on the DB-backed req.ctx.isAdmin (true for the validated synthetic
        // ADMIN_TOKEN / configured-admin-email), NOT the raw JWT role claim — a
        // signed role:'admin' token with a novel userId must not self-heal into a
        // new admin row.
        if (req.ctx?.isAdmin === true) {
          try {
            const adminEmail = String(user.email || ADMIN_EMAIL || '').trim().toLowerCase() || null
            const existingByEmail = adminEmail
              ? await req.db
                  .prepare(
                    `
                      SELECT *
                      FROM users
                      WHERE LOWER(TRIM(primary_email)) = ?
                      LIMIT 1
                    `,
                  )
                  .get(adminEmail)
              : null

            if (existingByEmail?.id) {
              await req.db
                .prepare(
                  `
                    UPDATE users
                    SET is_admin = TRUE
                    WHERE id = ?
                  `,
                )
                .run(existingByEmail.id)
              user.userId = existingByEmail.id
            } else {
              await req.db.prepare(
                `
                  INSERT INTO users (id, display_name, primary_email, is_admin)
                  VALUES (?, ?, ?, ?)
                `,
              ).run(
                user.userId,
                user.full_name || ADMIN_NAME || 'Admin User',
                adminEmail,
                true,
              )
            }

            dbUser = req.db
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
        // DB-backed admin ONLY (req.ctx.isAdmin is authoritative: fail-closed, and
        // denies a synthetic id arriving without service-token provenance). We do
        // NOT OR-in dbUser.is_admin — the persisted synthetic row (keyed by
        // system_admin_token) would otherwise let a JWT with a colliding `sub`
        // unlock the cross-org profile list.
        const isAdminUser = req.ctx?.isAdmin === true

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
          // DB-backed: owned + DB-verified-email-granted profiles. The bootstrap
          // list is NEVER derived from the token email (a JWT could claim
          // victim@example.com and pick up victim's shared profiles) — same
          // DB-trusted discipline as GET /api/profiles?scope=mine.
          const accessibleIds = await getOwnedAndGrantedProfileIds(req.db, user)
          const idList = Array.from(accessibleIds)
          if (idList.length > 0) {
            const placeholders = idList.map(() => '?').join(', ')
            profiles = await req.db
              .prepare(
                `
                  SELECT id, display_name, organization_id, status, created_at
                  FROM profiles
                  WHERE id IN (${placeholders})
                  ORDER BY created_at ASC
                `,
              )
              .all(...idList)
          } else {
            profiles = []
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

      // One-time forced welcome video gate (services/onboardingGates.js).
      // Fail-open: resolves to null on any error so /me never breaks bootstrap.
      const forcedWelcomeVideo = await resolveForcedWelcomeVideo(req.db, dbUser)

      return res.json({
        user: {
          id: dbUser.id,
          display_name: dbUser.display_name,
          primary_email: dbUser.primary_email,
          primary_phone: dbUser.primary_phone,
          avatar_url: dbUser.avatar_url,
          // Canonical, DB-backed admin (fails closed; rejects a synthetic-id
          // collision) — NEVER the raw dbUser.is_admin row, which a self-healed
          // users.id='system_admin_token' row would report true for a colliding JWT.
          is_admin: req.ctx?.isAdmin === true,
          // Durable onboarding/tour state (has_completed_onboarding,
          // guided_cycle_tour_status, ...) -- THIS is the handler that actually
          // serves every GET /api/auth/me request (registered on `app` before
          // authRouter is mounted at /api/auth, so it wins routing over the
          // near-identical handler in routes/auth.js, which was found to be
          // fully unreachable dead code and removed). Omitting these fields
          // here meant guidedCycleTourStatus/lastCompletedTourVersion silently
          // reset to their defaults on every page refresh / new-tab bootstrap,
          // even though the login-response path (buildUserPayload) had them
          // right all along.
          has_completed_onboarding: Boolean(dbUser.has_completed_onboarding),
          onboarding_completed_at: dbUser.onboarding_completed_at ?? null,
          last_seen_manual_version: Number(dbUser.last_seen_manual_version ?? 0),
          last_completed_tour_version: Number(dbUser.last_completed_tour_version ?? 0),
          tour_dismissed_at: dbUser.tour_dismissed_at ?? null,
          // Canonical admin reinterview gate (services/onboardingGates.js):
          // an admin who has completed onboarding or ever signed in before is
          // never served 'pending_reinterview' — a secondary admin login must
          // not re-trigger Anya's interview. Non-admins get the raw value.
          guided_cycle_tour_status: resolveGuidedCycleTourStatus(dbUser),
          // One-time forced welcome video (null for everyone with no unconsumed
          // forced row → zero behavior change). The frontend renders this above
          // every onboarding branch, then POSTs consume so it never replays.
          forced_welcome_video: forcedWelcomeVideo,
        },
        profiles: Array.isArray(profiles) ? profiles : [],
        active_profile_id: safeActiveProfileId,
      });
    }

    if (req.ctx?.isAdmin === true) {
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
app.get('/api/admin/pipeline-health', ensureAuth, ensureAdmin, (req, res) => {
  res.json(getPipelineHealth())
})

// Client-reported error sink. Frontend error boundaries POST here when the SPA
// crashes — INCLUDING on pre-auth pages (login/start/landing), which is exactly
// where the owner most wants crash visibility, so the endpoint stays open rather
// than requiring auth (which would silently drop those reports). It does NOT trust
// any client-supplied identity (it reads req.user, never a body field), and
// reportErrorToOwner self-skips admin/owner + applies a per-signature throttle and
// an hourly cap. The one residual abuse vector was unauthenticated FLOODING: an
// attacker varying the message/route can mint distinct signatures and burn the
// hourly cap with attacker-supplied (HTML-escaped) content. A per-IP rate limit
// closes that as the first line of defense. Fire-and-forget (returns 204/429).
const clientErrorReportLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  limit: 30, // generous for a real client (boundaries report rarely); blocks floods
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many error reports, please try again later.' },
});
app.post('/api/report-client-error', clientErrorReportLimiter, (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const message = typeof body.message === 'string' ? body.message.slice(0, 4000) : '';
    // Ignore noise / missing payloads — nothing to report without a message.
    if (!message.trim()) return res.status(204).end();

    const error = new Error(message);
    error.name = typeof body.name === 'string' && body.name.trim() ? body.name.slice(0, 200) : 'ClientError';
    if (typeof body.stack === 'string') error.stack = body.stack.slice(0, 8000);
    if (typeof body.componentStack === 'string' && body.componentStack.trim()) {
      error.stack = `${error.stack || ''}\n\nComponent stack:\n${body.componentStack.slice(0, 8000)}`;
    }

    reportErrorToOwner({
      error,
      source: 'frontend',
      user: req.user,
      route: typeof body.route === 'string' ? body.route.slice(0, 500) : null,
      method: 'CLIENT',
      requestId: req.requestId || req.id || req.request_id || null,
      statusCode: Number(body.statusCode) || 500,
    });
  } catch (err) {
    console.error('[report-client-error]', err?.message || err);
  }
  return res.status(204).end();
});

// API routes
app.use('/api/auth', authRouter);
app.use('/api/activity', activityRouter);
// Conversational onboarding — public, no auth required. This is the SINGLE
// entry funnel for new GrantFlow users: /start in the SPA talks to these
// endpoints, finishes by creating a profile + email-OTP credential, and hands
// the user off to /api/auth/email/verify with a stateless token.
// Maintenance window: when a window is DOWN, non-admin /api calls get 503 so the
// frontend can log users out of a glitching app. Status/auth/health are exempt
// (set inside the guard). Mounted here — after the global db/auth-context
// middleware so req.db/req.user/req.ctx are populated. Admin/owner pass through.
app.use('/api', maintenanceGuardMw)
// Public maintenance status + admin schedule/end + run-nightly-sweep.
app.use('/api/maintenance', lazyRouter('./routes/maintenance.js'));
// Public opaque media streaming (forced welcome video etc.) — see routes/media.js
// for why this is intentionally unauthenticated (a <video> tag can't send the
// bearer token; access is by opaque random id only).
app.use('/api/media', lazyRouter('./routes/media.js'));
app.use('/api/onboarding', lazyRouter('./routes/onboarding.js'));
app.use('/api/service-application', lazyRouter('./routes/serviceApplication.js'));
app.use('/api/billing', billingRouter);
// User-facing comms: email the owner alias from a profile + self-serve SMS opt-in.
app.use('/api/comms', lazyRouter('./routes/comms.js'));
app.use('/api/stats', responseCache(60_000), statsRouter);
app.use('/api/services', servicesRouter);
app.use('/api/stripe', stripeRouter);
// SINGLE CHOKE POINT for admin features: every current and future /api/admin/*
// sub-router is auth+admin gated here, so no individual router can leak by
// forgetting its own `router.use(ensureAdmin)`. Per-router gates below remain
// as defense-in-depth. Public signup reads /api/services (not /api/admin/*),
// and the public health probes live under /api/sam + /api/anya — unaffected.
app.use('/api/admin', ensureAuth, ensureAdmin)
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
app.use('/api/award-compliance', lazyRouter('./routes/awardCompliance.js'));
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
// Laptop Connector — admin-only ingest of locally-scanned files into a
// reviewable candidate inbox (lead/funding/profile_field). Lazy so the
// Anthropic SDK only loads when the connector is actually used.
app.use('/api/laptop-connector', lazyRouter('./routes/laptopConnector.js'));
// Controlled-vocabulary catalog for profile TAG pickers (needs / focus). Sourced
// from the matcher's OWN vocabulary (backend/config/profileVocabulary.js) so every
// pickable tag is guaranteed to score. Mounted BEFORE the profiles router so the
// explicit path can never be shadowed by its `/:id` route. Public/read-only.
app.get('/api/profiles/vocabulary', async (_req, res) => {
  try {
    const { PROFILE_VOCABULARIES } = await import('./config/profileVocabulary.js')
    res.set('Cache-Control', 'public, max-age=3600')
    res.json({ ok: true, vocabularies: PROFILE_VOCABULARIES, ...PROFILE_VOCABULARIES })
  } catch (err) {
    res.status(500).json({ ok: false, error: 'vocabulary_unavailable', message: err?.message || String(err) })
  }
})
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
// Per-profile "Portals" dashboard — GET /api/profiles/:id/portals returns every
// portal applicable to a profile (derived from pipeline grants + target colleges
// + saved credentials/sessions, deduped by registrable host), prepopulated with
// a resolved login URL + label + green/red status. Same /:id path convention as
// studentPortals; does not collide with the main profiles router.
app.use('/api', lazyRouter('./routes/profilePortals.js'));
app.use('/api', lazyRouter('./routes/fundingSources.js'));
app.use('/api', lazyRouter('./routes/announcements.js'));
// Committed-college financial-aid workspace (commit one school → others archive;
// aggregate COA / FAFSA / aid / matched funding / Hamilton status). Same
// /:profileId path convention as studentPortals.
app.use('/api', lazyRouter('./routes/committedCollege.js'));
app.use('/api/application-tasks', lazyRouter('./routes/applicationTasks.js'));
// Hamilton Automation Agent — Application Autopilot / Funding Completion.
// Note: existing Yana = Client Discovery / Lead Funnel and is unchanged.
app.use('/api/hamilton/automation', lazyRouter('./routes/hamiltonAutomation.js'));
// Hamilton Portal Sync — two-way portal ↔ GrantFlow data sync. READ pulls real
// data (test scores, financial-aid awards, application status) from a school /
// funder portal into the profile + pipeline using the profile's saved session /
// login; WRITE pushes GrantFlow funding sources/awards into the portal. Gated by
// HAMILTON_ENABLE_BROWSER_AUTOMATION + host allowlist inside the service.
app.use('/api/hamilton/portal-sync', lazyRouter('./routes/hamiltonPortalSync.js'));
// Hamilton Tailored Application — the per-funder, MBA-level, fabrication-guarded
// application narrative stored ON each portal card with an approval state.
// Auto-submit runs ONLY when approved/edited + no missing questions + the
// profile's auto-submit toggle is on (evaluateAutoSubmitGate is the choke point).
app.use('/api/hamilton/tailored', lazyRouter('./routes/hamiltonTailoredApplication.js'));
// Backwards-compatible alias so any in-flight client still works during
// the rollout. Both paths resolve to the same router.
app.use('/api/yana/automation', lazyRouter('./routes/hamiltonAutomation.js'));
app.use('/api/saved-grants', savedGrantsRouter);
app.use('/api/foundations', foundationsRouter);
// John — Outreach Drafting Agent. Draft-only; never sends. Admin-only except /health.
app.use('/api/john', lazyRouter('./routes/john.js'));
// Owner Blocklist — canonical denylist fed by phone (Tasker) + Gmail filters +
// manual entries. Enforced at auth, inbound, and outreach. Admin-only except
// the token-authed /ingest endpoint devices push to.
app.use('/api/blocklist', lazyRouter('./routes/blocklist.js'));
// Email → Grant ingestion. The owner's inbox bridge (Gmail Apps Script /
// forwarder) POSTs grant-announcement emails to the token-authed /ingest
// endpoint; parsed grants enter the catalog and flow through Smart Match /
// Discover. Admin can review/reject ingestions.
app.use('/api/email-grants', lazyRouter('./routes/emailGrants.js'));
// Yana Lead Discovery & Outreach pipeline. The router lives at
// backend/routes/yanaOutreach.js. /api/yana-leads is the canonical path
// the admin UI uses.
app.use('/api/yana-leads', lazyRouter('./routes/yanaOutreach.js'));
app.use('/api/yana-contacts', lazyRouter('./routes/yanaLeads.js'));
// Robert — Funding Discovery Agent. Disabled by default; the scheduler
// only starts if ROBERT_ENABLED + ROBERT_RUN_ON_SCHEDULE/STARTUP say so.
app.use('/api/robert', lazyRouter('./routes/robert.js'));

// Sam — production-readiness agent. /api/sam/health is public; everything
// else is admin-gated inside the router. Mounted after the rest of the API
// so Sam's HTTP probes can hit /api/health/* and /readyz cleanly.
app.use('/api/sam', lazyRouter('./routes/sam.js'))

// Amy — synthetic crawler-training agent. Admin-only; surfaces crawler-quality
// reports + improvement approval queue and an on-demand run trigger.
app.use('/api/amy', lazyRouter('./routes/amy.js'))

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

/**
 * The automatic profile de-dupe may MERGE/DELETE a profile ONLY when it was
 * created by the Amy→Anya→Sam synthetic crawler-training pipeline
 * (profiles.created_by === 'agent:amy') AND it has been crawled at least once
 * (amy_metadata.crawled_at present). Real and designated profiles are NEVER
 * auto-merged — they are left untouched for human review. This is the single
 * choke point that prevents the auto-dedupe from ever destroying real client
 * data (root cause of the 2026-06-20 incident where designated client profiles
 * were merged into UUID rows and tombstoned). On any error it fails SAFE
 * (returns not-eligible), so an unexpected DB shape can never green-light a
 * destructive merge of a real profile.
 */
async function amyDedupeEligibility(db, profileId) {
  const out = { synthetic: false, crawled: false }
  try {
    const row = await db.prepare('SELECT created_by FROM profiles WHERE id = ? LIMIT 1').get(profileId)
    out.synthetic = String(row?.created_by || '') === AMY_ORIGIN_CREATED_BY
    if (!out.synthetic) return out
    const sec = await db
      .prepare('SELECT data FROM profile_sections WHERE profile_id = ? AND section_key = ? LIMIT 1')
      .get(profileId, AMY_METADATA_SECTION_KEY)
    let meta = {}
    try { meta = sec?.data ? JSON.parse(sec.data) : {} } catch { meta = {} }
    out.crawled = Boolean(meta?.crawled_at)
  } catch {
    // Fail safe: any error → not eligible → never deleted.
  }
  return out
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

      // ── MISSION GUARD: only ever auto-merge Amy synthetic, already-crawled profiles ──
      // Every member of the group (the surviving winner AND every loser that gets
      // merged away/deleted) must be an Amy→Anya→Sam synthetic profile, and every
      // loser must have been crawled at least once. If ANY member is a real or
      // designated profile, skip the whole group and leave it for human review.
      // This is what stops the auto-dedupe from ever deleting real client data.
      {
        const members = [winner, ...losers]
        const eligibilities = await Promise.all(members.map((m) => amyDedupeEligibility(db, m.id)))
        const allSynthetic = eligibilities.every((e) => e.synthetic)
        // Losers are the rows that get destroyed — they must each be crawled ≥ once.
        const allLosersCrawled = eligibilities.slice(1).every((e) => e.crawled)
        if (!allSynthetic || !allLosersCrawled) {
          skippedGroups += 1
          console.info('[auto-dedupe] skipped group (real/designated data is never auto-merged; synthetic must be crawled first)', {
            runId, key: group.key, winnerId: winner.id, loserCount: losers.length, allSynthetic, allLosersCrawled,
          })
          logAuditEvent(db, {
            category: AUDIT_CATEGORIES.ADMIN,
            action: 'auto_profile_dedupe_skipped',
            severity: SEVERITY.INFO,
            resourceType: 'profile',
            resourceId: winner.id,
            details: {
              run_id: runId,
              group_key: group.key,
              reason: 'not_amy_synthetic_or_not_crawled',
              all_synthetic: allSynthetic,
              all_losers_crawled: allLosersCrawled,
              winner_id: winner.id,
              loser_ids: losers.map((l) => l.id),
            },
          })
          continue
        }
      }

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
app.use('/api/admin/rejections', lazyRouter('./routes/adminRejections.js'));
app.use('/api/admin/agent-telemetry', lazyRouter('./routes/agentTelemetry.js'));
// Admin-only health surface for Hamilton's two-way portal sync. Probed by
// Sam's `hamilton.portalSync.health` diagnostic; degrades to "not installed".
app.use('/api/admin/portal-sync', lazyRouter('./routes/portalSyncHealth.js'));
// Admin Agent Control Center — start/stop/pause/resume/emergency-stop the
// whole agent process. Restricted to the canonical operator
// (buckeye7066@gmail.com or AGENT_CONTROL_ADMIN_EMAIL env override).
app.use('/api/admin/agent-control', lazyRouter('./routes/adminAgentControl.js'));
// Admin-only, read-only crawl coverage & health dashboard (architecture #13):
// "did the crawler know where to look, did it query, what failed, what was
// found vs accepted vs rejected" — plus stale sources + weak-data profiles.
app.use('/api/admin/crawl-coverage', lazyRouter('./routes/adminCrawlCoverage.js'));
// Admin-only MUTATING companion to the above (kept in a separate file so the
// read-only dashboard route's documented "never mutates" contract holds):
// trigger one targeted, bounded re-crawl of a single stale source.
app.use('/api/admin/crawl-coverage-actions', lazyRouter('./routes/adminCrawlCoverageActions.js'));
// "Which crawlers fire for this profile, and why?" — explainable plan + a
// coverage audit that flags zero-coverage / org-directory-only profiles so a
// VFD can never silently miss FEMA AFG again (architecture: crawler planning).
app.use('/api/admin/crawler-plan', lazyRouter('./routes/adminCrawlerPlan.js'));
// Row-level crawler doctor: which QUERY produced each match, include/exclude
// reasoning, geography + eligibility explain, amount-extraction result, and
// the learned-gap query expansions the next crawl will add.
app.use('/api/admin/crawler-doctor', lazyRouter('./routes/adminCrawlerDoctor.js'));
// Owner-initiated outbound messaging (Broadcast screen): list recipients, send
// promotional/notification email (dr.johnwhite alias) or SMS, manage phones +
// opt-in. Admin-only inside the router.
app.use('/api/admin/comms', lazyRouter('./routes/adminComms.js'));
app.use('/api', requestTimeout(PIPELINE_TIMEOUT), discoveryRouter);
app.use('/api/crawler-v2', lazyRouter('./routes/crawlerV2.js'));
app.use('/api/nf-programs', lazyRouter('./routes/nfPrograms.js'));

// Pipeline stats
app.get('/api/pipeline/stats', async (req, res) => {
  try {
    const { PIPELINE_STAGES, canonicalStage } = await import('../shared/pipelineStages.js');
    // Scope to what the requester can access (admins → all) so this card
    // reconciles with the rest of the dashboard instead of leaking DB-wide
    // totals (the old query was globally unscoped).
    const scope = buildGrantScopeFromContext(req.ctx);
    // Fetch the rows (not a raw COUNT) and dedup duplicate pipeline entries for
    // the same opportunity BEFORE bucketing — using the SAME dedup as /api/grants
    // — so the funnel total matches the deduped lists instead of double-counting
    // re-discovered grants (the "Discovery 188 vs Discovered 11" discrepancy).
    const { dedupePipelineGrants } = await import('../shared/dedupePipelineGrants.js');
    const rawRows = await db.prepare(`
      SELECT id, status, funding_opportunity_id, title, funder, amount_awarded
      FROM grants
      WHERE ${scope.sql}
    `).all(...scope.params);
    const rows = dedupePipelineGrants(rawRows);

    // Bucket every grant into the canonical 11 pipeline stages via the single
    // source of truth (shared/pipelineStages.js). canonicalStage() resolves every
    // legacy alias so the funnel sums to the same total the rest of the app shows.
    const canonical = Object.fromEntries(PIPELINE_STAGES.map((s) => [s, 0]));
    rows.forEach((row) => {
      const stage = canonicalStage(row.status);
      if (stage && canonical[stage] !== undefined) {
        canonical[stage] += 1;
      }
    });

    // Backward-compatible aliases for existing dashboard cards.
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

// Serve React app for all non-API routes (SPA fallback).
// Express 5 / path-to-regexp v8: '*' is no longer a valid path — the named
// wildcard '/{*splat}' is the v5 equivalent (braces so it matches '/' too).
app.get('/{*splat}', spaFallbackLimiter, (req, res, next) => {
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

let shuttingDown = false
function gracefulShutdown(signal) {
  if (!server) return
  if (shuttingDown) return
  shuttingDown = true
  console.log(`\nReceived ${signal}, closing server gracefully...`);
  // The full rationale (the "Deploy Crashed"-on-every-deploy bug) lives in
  // backend/startup/gracefulShutdown.js. Behavior is unit-tested there.
  runGracefulShutdown({
    server,
    closeDb: () => db?.close?.(),
    flush: flushObservability,
    exit: (code) => process.exit(code),
    graceMs: Number(process.env.SHUTDOWN_GRACE_MS || 15000),
  });
}

if (process.env.NODE_ENV !== 'test') {
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  server = app.listen(PORT, '0.0.0.0');

  // Keep-alive race fix for intermittent bodiless 502s ("Application failed to
  // respond") behind the Railway edge / Vercel rewrite proxies. Node's default
  // keepAliveTimeout is 5s; the proxies hold upstream sockets far longer. When
  // Node closes an idle keep-alive socket at the exact moment the proxy writes
  // the next request into it, the proxy sees a reset and returns 502 to the
  // browser — scattered, random-endpoint 502s on otherwise-healthy deploys.
  // The server-side idle timeout must EXCEED every proxy's idle timeout so the
  // proxy is always the side that closes first. headersTimeout must in turn
  // exceed keepAliveTimeout or Node kills sockets mid-request-header.
  server.keepAliveTimeout = Number(process.env.HTTP_KEEPALIVE_TIMEOUT_MS || 620_000);
  server.headersTimeout = server.keepAliveTimeout + 5_000;

  // Run the boot data-repair sweep ONCE THE PORT IS OPEN, not before it.
  //
  // It still runs on EVERY boot — the guarantee CLAUDE.md makes ("boot wires the
  // invariant sweep directly so it cannot be skipped by self-heal schedule
  // changes") is unchanged. What changes is that it no longer holds the port
  // shut while it makes network calls, which is what made Railway's healthcheck
  // read 502 and declare the deployment crashed.
  //
  // Deliberately NOT awaited: the listen callback must return so the event loop
  // can serve the healthcheck. The sweep is per-step guarded and non-fatal, and
  // it reports its own outcome to system_kv (Sam's pipeline.invariantSweepOutcomes
  // reads it), so a failure is still observable rather than silent.
  server.on('listening', () => {
    const sweep = app.locals.runBootInvariantSweep
    setImmediate(() => {
      if (typeof sweep === 'function') {
        sweep().catch((err) => {
          console.warn('[enforce-invariants] deferred boot sweep failed (non-fatal):', err?.message || err);
        });
      }
      const promote = app.locals.runQualifiedPipelinePromotion
      if (typeof promote === 'function') {
        promote().catch((err) => {
          console.warn('[pipeline-promotion] deferred post-listen run failed (non-fatal):', err?.message || err);
        })
      }
    });
  });

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

    // Profile Portals pre-resolve — warm the profile_portal_index cache (login
    // URLs + labels + connectors) AHEAD of any dashboard click, so the per-
    // profile Portals view renders instantly. Cheap + deterministic (no AI),
    // best-effort, self-healing; the endpoint still computes on demand when the
    // cache is cold. Runs ~25s after boot, then every 6h. Bounded by profile cap.
    setTimeout(() => {
      ;(async () => {
        try {
          const { preResolveActiveProfiles } = await import('./services/hamilton/profilePortalIndex.js')
          const runOnce = () => runWithSchedulerLock(db, {
            lockName: 'profile-portals:pre-resolve',
            ttlMs: 30 * 60 * 1000,
            logger: console,
          }, () => preResolveActiveProfiles(db, { limit: 50 }))
            .then((r) => console.log('[profile-portals] pre-resolve:', JSON.stringify(r)))
            .catch((err) => console.warn('[profile-portals] pre-resolve failed:', err?.message || err))
          runOnce()
          setInterval(runOnce, 6 * 60 * 60 * 1000)
        } catch (err) {
          console.warn('[profile-portals] pre-resolve scheduler skipped:', err?.message || err)
        }
      })()
    }, 25_000);

    // County cache warm — regenerate the counties-by-state dataset that the admin
    // geo endpoints read. It lives under backend/data/ (gitignored + ephemeral on
    // Railway), so a fresh boot has no cache and county enumeration recomputes per
    // request. Rebuild it once from the app's own ZIP->county resolver (real data,
    // no network). Best-effort + non-blocking; requests keep the on-demand
    // fallback if this fails or is still running.
    setTimeout(() => {
      ;(async () => {
        try {
          const { warmCountyCache } = await import('./startup/warmCountyCache.js')
          const result = await warmCountyCache()
          console.log('[county-cache] warm:', JSON.stringify(result))
        } catch (err) {
          console.warn('[county-cache] warm skipped:', err?.message || err)
        }
      })()
    }, 30_000);

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
        // Wire Yana's live-web contact enricher (Brave Search) BEFORE the
        // scheduler starts, so the first discovery run can graduate prospects
        // from needs_enrichment -> qualified. Gated: only activates when
        // YANA_ALLOW_LIVE_WEB=true AND BRAVE_SEARCH_API_KEY is set; otherwise
        // enrichment stays an honest NOOP and prospects sit at needs_enrichment.
        try {
          const liveWeb = /^(1|true|yes|on)$/i.test(String(process.env.YANA_ALLOW_LIVE_WEB || ''))
          if (liveWeb) {
            // Yana's contact enricher shares ONE canonical web-search engine with
            // profile discovery (services/shared/webSearchEngine.js): Brave when
            // BRAVE_SEARCH_API_KEY is set, else keyless DuckDuckGo. This means Yana
            // can search the web even without a Brave key — YANA_ALLOW_LIVE_WEB is
            // the single master gate for Yana's outbound live-web access.
            const [{ searchWeb }, { makeHtmlFetcher }, { makeContactEnricher, setDefaultContactEnricher }] =
              await Promise.all([
                import('./services/shared/webSearchEngine.js'),
                import('./services/yana/webSearchProvider.js'),
                import('./services/yana/yanaContactEnrichment.js'),
              ])
            const enricher = makeContactEnricher({
              searchProvider: ({ query }) => searchWeb(query, { count: 5 }),
              fetcher: makeHtmlFetcher(),
            })
            setDefaultContactEnricher(enricher)
            const backend = process.env.BRAVE_SEARCH_API_KEY ? 'Brave' : 'DuckDuckGo'
            console.log(`[Server] Yana contact enricher wired (${backend} web search, live web ON)`)
          } else {
            console.log('[Server] Yana contact enricher is a NOOP (set YANA_ALLOW_LIVE_WEB=true to enable; Brave key optional)')
          }
        } catch (enrichErr) {
          console.warn('[Server] Yana contact enricher wiring failed (non-fatal):', enrichErr?.message || enrichErr)
        }
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
    // Hydrate Amy's persisted crawler improvements (scoring weights/floor +
    // source-coverage overrides) from the DB BEFORE anything serves matches, so
    // prior tuning takes effect immediately and survives restarts/redeploys.
    // Runs regardless of whether the Amy scheduler is enabled.
    ;(async () => {
      try {
        const [{ hydrateScoringTuning }, { hydrateCoverageOverrides }, { hydrateGenericTitleAdditions }] = await Promise.all([
          import('./config/scoringTuning.js'),
          import('./services/amy/crawlerCoverageEditor.js'),
          import('./services/amy/relevanceVocabularyEditor.js'),
        ])
        const scoring = await hydrateScoringTuning(db)
        const coverage = await hydrateCoverageOverrides(db)
        // Owner-approved generic-title phrases (Amy's relevance_precision
        // lever). kv is the durable record — a container filesystem is not.
        const relevance = await hydrateGenericTitleAdditions(db)
        if (scoring || coverage || relevance) {
          console.log('[Server] Amy tuning hydrated:', JSON.stringify({ scoring: scoring || null, coverage_sources: coverage ? Object.keys(coverage).length : 0, generic_title_phrases: relevance ? relevance.length : 0 }))
        }
      } catch (hydErr) {
        console.warn('[Server] Amy tuning hydrate skipped:', hydErr?.message || hydErr)
      }
    })();
    // Amy — synthetic crawler-training agent scheduler. ON by default in prod.
    // It runs ~daily, generates AMY_DAILY_PROFILE_TARGET (default 100) synthetic
    // profiles, runs them through Crawler-OS discovery, and STORES the discovered
    // opportunities in funding_opportunities (AMY_PERSIST=true) so agent Robert
    // can parse them. The synthetic profiles + their scoped matches are cleaned
    // up afterward; the real, deduped opportunities are retained for Robert.
    ;(async () => {
      try {
        const { startAmyScheduler } = await import('./services/amy/amyScheduler.js')
        const result = startAmyScheduler({ db, logger: console })
        if (result?.started) console.log(`[Server] Amy scheduler started (target=${result.daily_target}/day)`)
        else console.log('[Server] Amy scheduler not started:', result?.reason || 'disabled')
      } catch (amyErr) {
        console.warn('[Server] Amy scheduler startup skipped:', amyErr?.message || amyErr)
      }
    })();
    // Agent-control lock sweeper — reclaims orphaned/expired locks on a timer so
    // a lock left behind by a crashed worker self-heals even while the system is
    // idle (acquireLock already sweeps, but only when a run is attempted).
    (async () => {
      try {
        const { startLockSweeper } = await import('./services/agentControl/agentControlStore.js')
        startLockSweeper(db, { logger: console })
      } catch (sweepErr) {
        console.warn('[agent-control] lock sweeper failed to start:', sweepErr?.message || sweepErr)
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

        try {
          // Widen yana_lead_candidates.qualification_status to allow the
          // outbound-prospect status 'needs_enrichment'. The original 0089
          // constraint predates outbound discovery, so a prospect insert fails
          // the CHECK and aborts the whole Yana run. Self-heal on boot so prod
          // (and any DB where the migration hasn't replayed) is always correct.
          await db.exec(`
            ALTER TABLE yana_lead_candidates DROP CONSTRAINT IF EXISTS yana_lead_candidates_qualification_status_check;
            ALTER TABLE yana_lead_candidates ADD CONSTRAINT yana_lead_candidates_qualification_status_check
              CHECK (qualification_status IN ('candidate', 'qualified', 'unqualified', 'needs_enrichment'));
          `)
          console.log('[startup] yana qualification_status CHECK constraint verified/expanded')
        } catch (e) {
          console.warn('[startup] yana qualification_status constraint fix skipped:', e?.message)
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

    // Yana — Lead Discovery & Outreach Agent (service files under
    // backend/services/yanaOutreach/). Off by default; the scheduler is a
    // no-op unless YANA_LEADS_ENABLED=true (legacy alias LARRY_ENABLED) and
    // at least one of YANA_LEADS_RUN_ON_STARTUP / YANA_LEADS_RUN_ON_SCHEDULE
    // is true. The scheduler additionally refuses to start when the canonical
    // Yana client-discovery adapter is enabled (YANA_ENABLED=true) so the
    // two never double-run.
    ;(async () => {
      try {
        const { startYanaOutreachScheduler } = await import('./services/yanaOutreach/yanaOutreachScheduler.js')
        const result = startYanaOutreachScheduler({ db })
        if (result?.started) console.log('[Server] Yana lead scheduler started')
        else console.log('[Server] Yana lead scheduler not started:', result?.reason || 'disabled')
      } catch (err) {
        console.warn('[Server] Yana lead scheduler startup skipped:', err?.message)
      }
    })()

    // Hamilton — restart recovery. A redeploy kills any in-process autopilot
    // batch; tasks caught in a transient in-flight status (filling_portal,
    // generating_*, …) would otherwise stay orphaned forever because nothing
    // re-picks those statuses. Requeue the stale ones to ready_to_start so the
    // scheduler / next autopilot kick resumes them. Runs regardless of the
    // scheduler gates — recovery is data repair, not automation. 15 min stale
    // window so a rolling deploy's overlap (old container still finishing a
    // task) is never demoted mid-work.
    ;(async () => {
      try {
        const { reconcileOrphanedApplicationTasks } = await import('./startup/hamiltonTaskRecovery.js')
        const r = await reconcileOrphanedApplicationTasks(db, { staleMinutes: 15 })
        if (r?.demoted > 0) {
          console.log(`[Server] Hamilton restart recovery: requeued ${r.demoted}/${r.scanned} orphaned in-flight task(s)`)
        }
      } catch (err) {
        console.warn('[Server] Hamilton restart recovery skipped:', err?.message)
      }
    })()

    // Hamilton — Application Autopilot scheduler. OFF by default; only arms when
    // HAMILTON_RUN_ON_SCHEDULE=true AND HAMILTON_ENABLE_BROWSER_AUTOMATION=true.
    // This is the timer that re-picks autonomous portal runs deferred to
    // status='waiting_for_window' once their scheduled window opens: it drives
    // the existing HamiltonAgentAdapter (which SELECTs due waiting_for_window /
    // queued / auth-blocked tasks and re-runs the orchestrator with
    // autonomous=true). Without it, deferred portal runs never resume on their
    // own. Never blocks startup, never crashes the server on failure.
    ;(async () => {
      try {
        const { startHamiltonScheduler } = await import('./services/hamilton/hamiltonScheduler.js')
        const result = startHamiltonScheduler({ db })
        if (result?.started) console.log('[Server] Hamilton scheduler started:', JSON.stringify(result))
        else console.log('[Server] Hamilton scheduler not started:', result?.reason || 'disabled')
      } catch (err) {
        console.warn('[Server] Hamilton scheduler startup skipped:', err?.message)
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
      runWithSchedulerLock(db, {
        lockName: 'auto-profile-dedupe',
        ttlMs: 30 * 60 * 1000,
        logger: console,
      }, () => scheduleAutoProfileDedupe({ db })).catch((err) => {
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
  } else {
    // Resolve + apply the autonomous master toggle: the persisted Control-Center
    // setting (agent_settings 'anya.autonomous_enabled') wins; otherwise the env
    // default — ON by default (owner directive 2026-06-29). Seeding the in-memory
    // config means a later toggle flip takes effect on the next 30-min tick
    // without a restart.
    ;(async () => {
      try {
        const [{ getAgentSetting }, sched] = await Promise.all([
          import('./services/agentControl/agentControlStore.js'),
          import('./services/anyaAutonomousScheduler.js'),
        ])
        const persisted = await getAgentSetting(db, 'anya.autonomous_enabled')
        if (persisted !== null) sched.setAutonomousEnabled(persisted === 'true')
        const enabled = sched.isAutonomousEnabled()
        console.log(`[Anya] Autonomous scheduler ${enabled ? 'ENABLED' : 'disabled'} (${persisted !== null ? 'persisted toggle' : 'default'})`)

        // Startup run (5s after ready). Autonomous startup only when enabled AND
        // run-on-startup is configured; otherwise run basic startup crawlers.
        setTimeout(() => {
          if (enabled && sched.getAutonomousConfig().runOnStartup) {
            console.log('[Anya] Starting autonomous operations on server startup...')
            runWithSchedulerLock(db, { lockName: 'anya:startup', ttlMs: 2 * 60 * 60 * 1000, logger: console },
              () => sched.runOnStartup(db)).catch(err => console.error('[Anya] Failed to complete autonomous operations:', err))
          } else {
            runWithSchedulerLock(db, { lockName: 'anya:startup-operations', ttlMs: 2 * 60 * 60 * 1000, logger: console },
              () => runStartupOperations(db)).catch(err => console.error('[Anya] Failed to complete crawler operations:', err))
          }
        }, 5000)

        // Scheduled runner: ALWAYS wired (unless background services are off) so
        // the Control-Center toggle can enable autonomy without a restart.
        // checkSchedule() + runAllAutonomousOperations() re-check runOnSchedule and
        // the toggle-able enabled flag on every tick — a no-op when disabled.
        const SCHEDULE_CHECK_MS = 30 * 60 * 1000
        setInterval(() => {
          import('./services/anyaAutonomousScheduler.js')
            .then(({ checkSchedule }) => {
              runWithSchedulerLock(db, { lockName: 'anya:scheduled-check', ttlMs: 45 * 60 * 1000, logger: console },
                () => checkSchedule(db)).catch(err => console.error('[Anya] Scheduled check failed:', err?.message || err))
            })
            .catch((err) => {
              /* intentionally non-fatal: scheduler import failure must not crash the interval */
              serverLogger.debug('anya.scheduler_import_failed', { error: err?.message || String(err) })
            })
        }, SCHEDULE_CHECK_MS)
        console.log('[Anya] Scheduled runner wired (every 30 min; respects the autonomous toggle)')
      } catch (err) {
        console.error('[Anya] autonomous boot seed failed:', err?.message || err)
      }
    })()
  }

  // Daily profile-aware auto-discovery is now driven by the Crawler OS through
  // Robert's scheduler (services/robert/robertScheduler.js -> runRobert ->
  // Crawler OS), which is the SINGLE scheduled-discovery authority. The legacy
  // scheduledAutoDiscovery crawler job is intentionally removed here so there is
  // no competing old scheduled crawler job (cutover invariant: one discovery
  // pipeline, no dual-run). To run scheduled discovery, enable Robert
  // (ROBERT_ENABLED / ROBERT_RUN_ON_SCHEDULE).
  if (!BACKGROUND_SERVICES_DISABLED && process.env.AUTO_DISCOVERY_DAILY_ENABLED === 'true') {
    console.log('[scheduled-auto-discovery] Legacy daily discovery removed — Crawler OS via Robert scheduler is the discovery driver.');
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
      runWithSchedulerLock(db, {
        lockName: 'deadline-cron',
        ttlMs: 30 * 60 * 1000,
        logger: console,
      }, () => runDeadlineCron()).catch((err) => {
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
          runWithSchedulerLock(db, {
            lockName: 'deadline-cron',
            ttlMs: 30 * 60 * 1000,
            logger: console,
          }, () => runDeadlineCron()).catch((err) => {
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
    const lockedRunOnce = () => runWithSchedulerLock(dbInstance, {
      lockName: 'link-verification',
      ttlMs: Math.max(30 * 60 * 1000, Math.min(intervalMs, 2 * 60 * 60 * 1000)),
      logger: console,
    }, runOnce)
    setTimeout(lockedRunOnce, 30_000)
    setInterval(lockedRunOnce, intervalMs)
  }

  // Billing cycle — generate due invoices (weekly Fri 09:00 ET / semimonthly /
  // monthly) + dunning (3-day second notice, 7-day suspend). Checks hourly;
  // runBillingCycle is idempotent (one invoice per period) and a NO-OP unless
  // BILLING_AUTOMATION_ENABLED=true, so this is safe to always schedule.
  function scheduleBillingCycle(dbInstance) {
    const intervalMs = Math.max(15 * 60 * 1000, Number(process.env.BILLING_CYCLE_INTERVAL_MS) || 60 * 60 * 1000)
    const runOnce = async () => {
      try {
        const r = await runBillingCycle(dbInstance, {})
        if (r.ran) console.log('[billing-cycle]', r)
      } catch (err) {
        console.warn('[billing-cycle] failed:', err.message)
      }
    }
    const lockedRunOnce = () => runWithSchedulerLock(dbInstance, {
      lockName: 'billing-cycle',
      ttlMs: Math.max(15 * 60 * 1000, Math.min(intervalMs, 60 * 60 * 1000)),
      logger: console,
    }, runOnce)
    setTimeout(lockedRunOnce, 45_000)
    setInterval(lockedRunOnce, intervalMs)
  }

  // Weekly link-verification report — every Monday ~06:00 America/New_York, run
  // a top-up verification pass and email the owner a link-health summary. Runs
  // entirely in-process using the prod env (DATABASE_URL + RESEND), so unlike a
  // cloud routine it needs NO external scheduler or injected secret. Hourly
  // check; an in-memory guard prevents repeat runs within the same ET day (a
  // rare restart-induced duplicate is harmless — runLinkVerification is
  // idempotent and it is at worst one extra email).
  // Tunable: WEEKLY_VERIFY_CHUNKS (default 6) x LINK_VERIFICATION_BATCH per run.
  // Tiny generic key/value store, created on demand (dialect-safe DDL). Used by
  // the weekly report to persist a "last run" marker so a missed Monday-06:00
  // window is caught up after a restart instead of skipped for the week.
  async function ensureSystemKv(dbInstance) {
    await dbInstance
      .prepare('CREATE TABLE IF NOT EXISTS system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)')
      .run()
  }
  async function kvGet(dbInstance, key) {
    const row = await dbInstance.prepare('SELECT value FROM system_kv WHERE key = ?').get(key)
    return row ? row.value : null
  }
  async function kvSet(dbInstance, key, value) {
    const now = new Date().toISOString()
    const res = await dbInstance
      .prepare('UPDATE system_kv SET value = ?, updated_at = ? WHERE key = ?')
      .run(value, now, key)
    const changed = Number(res?.changes ?? res?.rowCount ?? 0)
    if (!changed) {
      await dbInstance
        .prepare('INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)')
        .run(key, value, now)
    }
  }

  function scheduleWeeklyVerificationReport(dbInstance) {
    const MARKER = 'weekly_verify_last_run'
    // Shared ET clock (utils/etTime.js) — clamps the Node 20 midnight hour-"24"
    // quirk that made these windows open at 00:xx ET instead of the trigger hour.
    const nowEt = etNowParts
    // The Monday (YYYY-MM-DD, ET) whose 06:00 window has most recently opened.
    // Before Monday 06:00 this points at the PREVIOUS Monday, so the new week is
    // not yet eligible. Comparing this to the persisted marker gives both the
    // once-per-week guard and automatic catch-up for a missed window.
    const eligibleWeekKey = (parts) => etEligibleWeekKey(6, parts)
    const runOnce = async () => {
      try {
        await ensureSystemKv(dbInstance)
        const weekKey = eligibleWeekKey(nowEt())
        const last = await kvGet(dbInstance, MARKER)
        if (last === weekKey) return // already ran for this week's Monday window
        const chunks = Math.max(1, Number(process.env.WEEKLY_VERIFY_CHUNKS) || 6)
        const limit = Math.max(50, Number(process.env.LINK_VERIFICATION_BATCH) || 500)
        let checked = 0
        let ok = 0
        let broken = 0
        for (let i = 0; i < chunks; i += 1) {
          const s = await runLinkVerification(dbInstance, { limit, verifiedBy: 'weekly-report' })
          checked += s.checked
          ok += s.ok || 0
          broken += s.broken || 0
          if (s.checked === 0) break // backlog drained for this run
        }
        const health = await getLinkHealthSummary(dbInstance)
        const byStatus = Object.fromEntries(
          (health || []).map((r) => [r.link_status || 'unknown', Number(r.count)]),
        )
        const text = [
          `GrantFlow weekly link verification — week of ${weekKey} (America/New_York)`,
          '',
          `This pass: checked ${checked}, ok ${ok}, broken ${broken}.`,
          `Catalog link health: ${JSON.stringify(byStatus)}.`,
          '',
          'The in-app verifier also runs every 6h between these weekly passes.',
        ].join('\n')
        console.log('[weekly-verify-report]', { checked, ok, broken, byStatus })
        if (isEmailServiceConfigured()) {
          await sendEmail({
            to: ADMIN_EMAIL,
            subject: `GrantFlow weekly link verification — ${byStatus.unverified ?? 0} unverified remaining`,
            text,
            html: `<pre style="font:14px/1.5 monospace">${text.replace(/</g, '&lt;')}</pre>`,
          })
          console.log('[weekly-verify-report] emailed', ADMIN_EMAIL)
        } else {
          console.warn('[weekly-verify-report] email service not configured; logged only')
        }
        // Persist the marker AFTER a successful run so a transient failure
        // (DB hiccup, email outage) simply retries on the next hourly tick
        // rather than being recorded as done.
        await kvSet(dbInstance, MARKER, weekKey)
      } catch (err) {
        console.warn('[weekly-verify-report] failed:', err.message)
      }
    }
    const lockedRunOnce = () => runWithSchedulerLock(dbInstance, {
      lockName: 'weekly-verification-report',
      ttlMs: 2 * 60 * 60 * 1000,
      logger: console,
    }, runOnce)
    setTimeout(lockedRunOnce, 60_000)
    setInterval(lockedRunOnce, 60 * 60 * 1000) // hourly check; catches up a missed Monday window
  }

  // Hamilton weekly per-profile funding digest — every Monday 08:00
  // America/New_York, draft one Outlook message per profile (to every email on
  // the profile) into the owner's draft box. Runs in-process regardless of who
  // is logged in. Same hourly-tick + ET-week-key marker pattern as the weekly
  // verification report (once-per-week guard + automatic catch-up on restart).
  function scheduleHamiltonWeeklyDigest(dbInstance) {
    const MARKER = 'hamilton_weekly_digest_last_run'
    const TRIGGER_HOUR = Math.max(0, Math.min(23, Number(process.env.HAMILTON_WEEKLY_DIGEST_HOUR_ET) || 8))
    // Shared ET clock (utils/etTime.js) — clamps the Node 20 midnight hour-"24"
    // quirk that made these windows open at 00:xx ET instead of the trigger hour.
    const nowEt = etNowParts
    // The Monday (YYYY-MM-DD, ET) whose TRIGGER_HOUR window has most recently
    // opened; before that on Monday it points at the previous Monday.
    const eligibleWeekKey = (parts) => etEligibleWeekKey(TRIGGER_HOUR, parts)
    const runOnce = async () => {
      try {
        await ensureSystemKv(dbInstance)
        const weekKey = eligibleWeekKey(nowEt())
        const last = await kvGet(dbInstance, MARKER)
        if (last === weekKey) return // already drafted this week's Monday window
        const { runHamiltonWeeklyDigest } = await import('./services/hamilton/hamiltonWeeklyDigest.js')
        const summary = await runHamiltonWeeklyDigest(dbInstance, {})
        console.log('[hamilton-weekly-digest]', summary)
        // Observability: persist the last-run summary for Sam/admin/Anya status.
        try { await kvSet(dbInstance, `${MARKER}_summary`, JSON.stringify({ week: weekKey, ...summary })) } catch { /* best-effort */ }
        // Only mark done when it actually ran (provider configured, etc.), so a
        // not-yet-configured environment retries on the next tick.
        if (summary?.ran) await kvSet(dbInstance, MARKER, weekKey)
      } catch (err) {
        console.warn('[hamilton-weekly-digest] failed:', err.message)
      }
    }
    const lockedRunOnce = () => runWithSchedulerLock(dbInstance, {
      lockName: 'hamilton-weekly-digest',
      ttlMs: 2 * 60 * 60 * 1000,
      logger: console,
    }, runOnce)
    setTimeout(lockedRunOnce, 90_000)
    setInterval(lockedRunOnce, 60 * 60 * 1000) // hourly check; catches up a missed Monday 08:00 ET window
  }

  // Monday-morning UNMERGED-PORTAL reminder — every Monday 09:00 America/New_York
  // (owner requirement: "unmerged portals need to be sent as reminders at least
  // once a week, Monday mornings"). For each profile with portals that are NOT
  // merged (including completed-but-not-merged), send ONE reminder per profile to
  // its contact emails via the existing comms channel. Same ET-week-key marker +
  // hourly-tick pattern as the Hamilton digest (once-per-week guard + catch-up on
  // restart). The marker is the primary idempotency guard; the reminder service
  // also stamps last_reminded_at per portal.
  function scheduleMondayPortalReminder(dbInstance) {
    const MARKER = 'monday_portal_reminder_last_run'
    const TRIGGER_HOUR = Math.max(0, Math.min(23, Number(process.env.MONDAY_PORTAL_REMINDER_HOUR_ET) || 9))
    // Shared ET clock (utils/etTime.js) — clamps the Node 20 midnight hour-"24"
    // quirk that made these windows open at 00:xx ET instead of the trigger hour.
    const nowEt = etNowParts
    // The Monday (YYYY-MM-DD, ET) whose TRIGGER_HOUR window has most recently
    // opened; before that on Monday it points at the previous Monday.
    const eligibleWeekKey = (parts) => etEligibleWeekKey(TRIGGER_HOUR, parts)
    const runOnce = async () => {
      try {
        await ensureSystemKv(dbInstance)
        const weekKey = eligibleWeekKey(nowEt())
        const last = await kvGet(dbInstance, MARKER)
        if (last === weekKey) return // already sent this week's Monday window
        const { runMondayPortalReminder, isMondayPortalReminderEnabled } = await import('./services/hamilton/mondayPortalReminder.js')
        if (!isMondayPortalReminderEnabled()) { await kvSet(dbInstance, MARKER, weekKey); return }
        const summary = await runMondayPortalReminder(dbInstance, {})
        console.log('[monday-portal-reminder]', summary)
        // Observability: persist the last-run summary for Sam/admin/Anya status.
        try { await kvSet(dbInstance, `${MARKER}_summary`, JSON.stringify({ week: weekKey, ...summary })) } catch { /* best-effort */ }
        if (summary?.ran) await kvSet(dbInstance, MARKER, weekKey)
      } catch (err) {
        console.warn('[monday-portal-reminder] failed:', err.message)
      }
    }
    const lockedRunOnce = () => runWithSchedulerLock(dbInstance, {
      lockName: 'monday-portal-reminder',
      ttlMs: 2 * 60 * 60 * 1000,
      logger: console,
    }, runOnce)
    setTimeout(lockedRunOnce, 90_000)
    setInterval(lockedRunOnce, 60 * 60 * 1000) // hourly check; catches up a missed Monday 09:00 ET window
  }

  // Sam's nightly maintenance sweep — every day 04:00 America/New_York. Enters a
  // maintenance window (same banner users see for a deploy), runs Sam in
  // repair-safe mode, and reopens only when green. Hourly tick + ET-day marker
  // (once-per-day guard + catch-up after a restart).
  function scheduleNightlyMaintenanceSweep(dbInstance) {
    const MARKER = 'nightly_maintenance_last_run'
    const TRIGGER_HOUR = Math.max(0, Math.min(23, Number(process.env.NIGHTLY_MAINTENANCE_HOUR_ET) || 4))
    // Shared ET clock (utils/etTime.js) — clamps the Node 20 midnight hour-"24"
    // quirk that made these windows open at 00:xx ET instead of the trigger hour.
    const nowEt = etNowParts
    // The ET day (YYYY-MM-DD) whose TRIGGER_HOUR window has opened; before that
    // hour it points at the previous day so today isn't yet eligible.
    const eligibleDayKey = (parts) => etEligibleDayKey(TRIGGER_HOUR, parts)
    const runOnce = async () => {
      try {
        await ensureSystemKv(dbInstance)
        // Self-heal a stranded maintenance window FIRST, before the once-per-day
        // marker check — the stuck case is precisely "already swept today but the
        // sweep crashed before reopening", so this must run even when the marker
        // says today is done. Reopens an overdue automated window so users aren't
        // locked out. Best-effort.
        try {
          const { reopenStaleMaintenance } = await import('./services/maintenance/maintenanceMode.js')
          const healed = await reopenStaleMaintenance(dbInstance)
          if (healed?.reopened) console.warn('[nightly-maintenance] self-healed stranded window:', healed.reason)
        } catch (healErr) {
          console.warn('[nightly-maintenance] stale-window self-heal failed:', healErr?.message)
        }
        const dayKey = eligibleDayKey(nowEt())
        const last = await kvGet(dbInstance, MARKER)
        if (last === dayKey) return // already swept for this ET day
        const { runNightlyMaintenanceSweep, isNightlySweepEnabled } = await import('./services/maintenance/nightlySweep.js')
        if (!isNightlySweepEnabled()) { await kvSet(dbInstance, MARKER, dayKey); return }
        const result = await runNightlyMaintenanceSweep(dbInstance, {})
        console.log('[nightly-maintenance]', result)
        // Mark done for the day regardless of green (we don't want to re-enter
        // maintenance every hour); a non-green result leaves maintenance ON for a
        // human, and the marker prevents a thrash loop.
        await kvSet(dbInstance, MARKER, dayKey)
      } catch (err) {
        console.warn('[nightly-maintenance] failed:', err.message)
      }
    }
    const lockedRunOnce = () => runWithSchedulerLock(dbInstance, {
      lockName: 'nightly-maintenance',
      ttlMs: 2 * 60 * 60 * 1000,
      logger: console,
    }, runOnce)
    setTimeout(lockedRunOnce, 120_000)
    setInterval(lockedRunOnce, 60 * 60 * 1000) // hourly check; catches up a missed 04:00 ET window
  }

  // Qualified-pipeline convergence is deliberately outside the boot invariant
  // chain. Its own runner reaps expired Amy profiles first, then promotes real
  // profiles round-robin. Both the nightly tick and post-listen catch-up call the
  // same distributed-lock + ET-day-marker wrapper, so replicas cannot overlap.
  function scheduleQualifiedPipelinePromotion(dbInstance) {
    const TRIGGER_HOUR = Math.max(0, Math.min(23, Number(process.env.PIPELINE_PROMOTION_HOUR_ET) || 4))
    const runOnce = async () => {
      try {
        await ensureSystemKv(dbInstance)
        const { runScheduledQualifiedPipelinePromotion } = await import('./services/pipelinePromotion.js')
        const result = await runScheduledQualifiedPipelinePromotion(dbInstance, {
          source: 'nightly',
          triggerHour: TRIGGER_HOUR,
          logger: console,
        })
        console.log('[pipeline-promotion] nightly', result)
      } catch (err) {
        console.warn('[pipeline-promotion] nightly failed:', err?.message || err)
      }
    }
    setTimeout(runOnce, 180_000)
    setInterval(runOnce, 60 * 60 * 1000)
  }

  // Sam's daily FULL code/function sweep — every day 05:00 America/New_York.
  // Runs Sam's HEAVY checks (source scan, broken-import crawl, ESLint, mission/
  // SQL-safety audit) READ-ONLY (advise mode, no prod gates, no maintenance
  // window) and persists the findings to sam_runs. Two consumers read this run:
  // the sam-autofix GitHub Action (corrects + ships the auto-fixable issues) and
  // Anya's 09:00 ET owner report (emails the human what still needs attention).
  // We stash the run id in system_kv so Anya reads exactly this sweep. Same
  // hourly-tick + ET-day-key marker pattern (once-per-day guard + catch-up).
  function scheduleSamDailyCodeSweep(dbInstance) {
    const MARKER = 'sam_daily_code_sweep_last_run'
    const RUN_ID_KEY = 'sam_daily_code_sweep_run_id'
    const TRIGGER_HOUR = Math.max(0, Math.min(23, Number(process.env.SAM_DAILY_CODE_SWEEP_HOUR_ET) || 5))
    // Shared ET clock (utils/etTime.js) — clamps the Node 20 midnight hour-"24"
    // quirk that made these windows open at 00:xx ET instead of the trigger hour.
    const nowEt = etNowParts
    const eligibleDayKey = (parts) => etEligibleDayKey(TRIGGER_HOUR, parts)
    const runOnce = async () => {
      try {
        await ensureSystemKv(dbInstance)
        const dayKey = eligibleDayKey(nowEt())
        const last = await kvGet(dbInstance, MARKER)
        if (last === dayKey) return // already swept for this ET day
        const { runSamDailyCodeSweep, isSamDailyCodeSweepEnabled } = await import('./services/sam/samDailyCodeSweep.js')
        if (!isSamDailyCodeSweepEnabled()) { await kvSet(dbInstance, MARKER, dayKey); return }
        const summary = await runSamDailyCodeSweep(dbInstance, {})
        console.log('[sam-daily-code-sweep]', summary)
        // Hand the run id to Anya + persist the summary for status/observability.
        try {
          if (summary?.run_id) await kvSet(dbInstance, RUN_ID_KEY, String(summary.run_id))
          await kvSet(dbInstance, `${MARKER}_summary`, JSON.stringify({ day: dayKey, ...summary }))
        } catch { /* best-effort */ }
        if (summary?.ran) await kvSet(dbInstance, MARKER, dayKey)
      } catch (err) {
        console.warn('[sam-daily-code-sweep] failed:', err.message)
      }
    }
    const lockedRunOnce = () => runWithSchedulerLock(dbInstance, {
      lockName: 'sam-daily-code-sweep',
      ttlMs: 2 * 60 * 60 * 1000,
      logger: console,
    }, runOnce)
    setTimeout(lockedRunOnce, 120_000)
    setInterval(lockedRunOnce, 60 * 60 * 1000) // hourly check; catches up a missed 05:00 ET window
  }

  // Anya's daily owner code report — every day 09:00 America/New_York. Reads the
  // findings from Sam's 05:00 sweep (via the system_kv run-id pointer; falls back
  // to the latest Sam run) and emails the owner a plain-English digest of the
  // code/function errors/weaknesses/bugs that still need a human, plus a note on
  // what was auto-corrected. Same tick + ET-day-key pattern; only marks
  // done once the email actually sends, so a not-yet-configured mailbox retries.
  // Ticks every 10 min (not hourly): Railway redeploys re-phase setInterval, and
  // an hourly tick let the owner's 09:00 email drift as late as 09:59.
  function scheduleAnyaDailyOwnerReport(dbInstance) {
    const MARKER = 'anya_daily_owner_report_last_run'
    const TRIGGER_HOUR = Math.max(0, Math.min(23, Number(process.env.ANYA_DAILY_REPORT_HOUR_ET) || 9))
    // Shared ET clock (utils/etTime.js) — clamps the Node 20 midnight hour-"24"
    // quirk that made these windows open at 00:xx ET instead of the trigger hour.
    const nowEt = etNowParts
    const eligibleDayKey = (parts) => etEligibleDayKey(TRIGGER_HOUR, parts)
    const runOnce = async () => {
      try {
        await ensureSystemKv(dbInstance)
        const dayKey = eligibleDayKey(nowEt())
        const last = await kvGet(dbInstance, MARKER)
        if (last === dayKey) return // already reported for this ET day
        const { runAnyaDailyOwnerReport, isAnyaDailyReportEnabled } = await import('./services/anya/anyaDailyOwnerReport.js')
        if (!isAnyaDailyReportEnabled()) { await kvSet(dbInstance, MARKER, dayKey); return }
        const runId = await kvGet(dbInstance, 'sam_daily_code_sweep_run_id')
        const summary = await runAnyaDailyOwnerReport(dbInstance, { runId: runId || null })
        console.log('[anya-daily-owner-report]', summary)
        try { await kvSet(dbInstance, `${MARKER}_summary`, JSON.stringify({ day: dayKey, ...summary })) } catch { /* best-effort */ }
        // Only mark done when the email actually sent (mailbox configured), so a
        // misconfigured environment retries on the next tick instead of skipping.
        if (summary?.sent) await kvSet(dbInstance, MARKER, dayKey)
      } catch (err) {
        console.warn('[anya-daily-owner-report] failed:', err.message)
      }
    }
    const lockedRunOnce = () => runWithSchedulerLock(dbInstance, {
      lockName: 'anya-daily-owner-report',
      ttlMs: 2 * 60 * 60 * 1000,
      logger: console,
    }, runOnce)
    setTimeout(lockedRunOnce, 150_000)
    setInterval(lockedRunOnce, 10 * 60 * 1000) // 10-min check; keeps the owner email within minutes of 09:00 ET and catches up a missed window
  }

  if (BACKGROUND_SERVICES_DISABLED) {
    console.info('[startup] Link verification, health service, and Anya cleanup disabled for smoke/test startup')
  } else {
    scheduleLinkVerification(db)
    scheduleBillingCycle(db)
    scheduleWeeklyVerificationReport(db)
    scheduleHamiltonWeeklyDigest(db)
    scheduleMondayPortalReminder(db)
    scheduleNightlyMaintenanceSweep(db)
    scheduleQualifiedPipelinePromotion(db)
    scheduleSamDailyCodeSweep(db)
    scheduleAnyaDailyOwnerReport(db)

    // Immediate boot-time net: if a previous nightly sweep crashed and left the
    // app stuck in a DOWN maintenance window, reopen it now rather than waiting
    // for the first hourly tick (~2 min) so a redeploy un-strands users at once.
    import('./services/maintenance/maintenanceMode.js')
      .then(({ reopenStaleMaintenance }) => reopenStaleMaintenance(db))
      .then((r) => { if (r?.reopened) console.warn('[startup] reopened stranded maintenance window:', r.reason) })
      .catch((err) => console.warn('[startup] maintenance self-heal failed:', err?.message || err));

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
