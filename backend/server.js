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
import jwt from 'jsonwebtoken';
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
import { errorHandler } from './middleware/errorHandler.js';
import { attachRequestContext } from './middleware/requestContext.js';
import { pipelineMonitor, getPipelineHealth } from './middleware/pipelineMonitor.js';
import { requestTimeout } from './middleware/requestTimeout.js';
import { responseCache } from './middleware/responseCache.js';
import { MAX_JSON_BODY_SIZE } from './config/constants.js';
import { getSafeHealthSummary } from './services/diagnosticsService.js';
import { assertFundingApiKeys, getFundingApiKeyPresence } from './src/config/apiKeys.js';
import { ensureProfileEmailSchema } from './utils/accessControl.js';
import { assertEnv } from './config/env.js'
import { resolveUploadsDir } from './utils/uploadsDir.js'
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
await runSelfHeal({ db, uploadsDir, IS_SMOKE_MODE, baseDir: __dirname });

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
    ((expectedAdminToken && xAdminToken === expectedAdminToken) ||
      (expectedBulkKey && xAdminToken === expectedBulkKey))
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
  if (!handled && xAnyaToken && process.env.ANYA_API_KEY && xAnyaToken === process.env.ANYA_API_KEY) {
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
        (expectedAdminToken && token === expectedAdminToken) ||
        (expectedBulkKey && token === expectedBulkKey)
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
      if (!handled && process.env.ANYA_API_KEY && token === process.env.ANYA_API_KEY) {
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

    if (!handled && token && ADMIN_TOKEN && token === ADMIN_TOKEN) {
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
    const loggedCorsOrigins = Array.isArray(corsOptions.origin)
      ? corsOptions.origin
      : [corsOptions.origin];
    console.log(`CORS origins: ${loggedCorsOrigins.join(', ')}`);
    const actualPort = server.address()?.port ?? PORT;
    console.log('[Server] Ready on port', actualPort);

    // ── Phase 3: Queue recovery ───────────────────────────────────────────────
    runQueueRecovery({ db, uploadsDir });

    // ── Phase 4: Background services ─────────────────────────────────────────
    startBackgroundServices({ db, uploadsDir, actualPort, loggedCorsOrigins });
  });
} else {
  console.info('[server] NODE_ENV=test; HTTP listener disabled')
}

export default app;
