import express from 'express';
import crypto from 'crypto';
import multer from 'multer';
import fs from 'fs';
import { promises as fsp } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import pdfParse from 'pdf-parse';
import { createOpenAIClient, summarizeOpenAIError } from '../utils/openaiClient.js';
import { encryptRuntimeSecret } from '../utils/runtimeSecrets.js';
import { seedRealOpportunities } from '../utils/seedRealOpportunities.js';
import { seedAssistanceDirectories } from '../utils/seedAssistanceDirectories.js';
import { ensureDesignatedProfiles } from '../utils/ensureDesignatedProfiles.js';
import { seedBaselineFromRepo } from '../utils/seedBaselineFromRepo.js';
import { buildProfileSignals } from '../services/profileHelpers.js';
import { getSystemDiagnostics } from '../services/diagnosticsService.js';
import { getFundingSourceStatus } from '../src/config/fundingSources.js'
import { listClientSignInEvents } from '../services/adminLoginEventStore.js'
import { linkProfileToAdmin } from '../utils/adminProfileLinks.js';
import { dispatchCrawlerJob } from '../services/crawlerDispatcher.js';
import { logAuditEvent, queryAuditLogs, getAuditSummary, cleanupAuditLogs, AUDIT_CATEGORIES, SEVERITY } from '../services/auditService.js';
import { initializeFeatureFlags, isFeatureEnabled, getAllFlags, updateFlag, createFlagOverride, removeFlagOverride, getFlagOverrides, cleanupExpiredOverrides } from '../services/featureFlagService.js';
import { getRequestError } from '../services/requestIdErrorStore.js';
import { extractTextFromFile } from '../services/documentTextExtraction.js'
import { crawlItemFunding, runCrawler as runCuratedCrawlerForAudit } from '../services/crawlerOsCompatibility.js';
import { findDuplicateProfileGroups, mergeProfiles, deduplicateProfileGroups, coerceDryRun } from '../services/profileDedupeService.js'
import { ensureAdminUser, addProfileEmails, listProfileEmails } from '../utils/accessControl.js'
import { ensureAuth, ensureAdmin } from '../middleware/auth.js'
import { repairProfileOwnership } from '../utils/profileOwnershipRepair.js'
import zipcodes from 'zipcodes';
import { resolveCountyForZip } from '../services/geo/zipCountyResolver.js';
import { resolveUploadsDir, ensureUploadsDirWritable } from '../utils/uploadsDir.js'
import { isDesignatedProfileId } from '../utils/ensureDesignatedProfiles.js'
import { analyzeKnowledgeBaseDocument, processPendingKBDocuments, extractFundingOpportunitiesFromKB } from '../services/knowledgeBaseProcessor.js'
import { runHealthCheck, getLastHealthStatus } from '../services/anyaHealthService.js'
import { runAutoRepair } from '../services/anyaAutoRepairService.js'
import { runRegionalPurge, getPurgeSummary, getPurgeEvents } from '../services/regionalPurgeService.js'
import { restoreProfileSectionsFromLinkedOrganizations } from '../services/profileOrganizationSync.js'
import { runAutonomousCodeCrawl } from '../services/anyaAutonomousCrawler.js'
import { auditPipelinesAgainstGoals } from '../services/pipelineGoalCleanupService.js'
import { fetchPublicResource, publicFetchFailureStatus } from '../utils/safeRemoteFetch.js'

import { createLogger } from '../utils/logger.js'
const routeLogger = createLogger('route:admin')

const router = express.Router();

// Router-level admin guard: all routes in this file require authentication and admin privileges.
router.use(ensureAuth)
router.use(ensureAdmin)

// Configuration constants
const MAX_TEXT_LENGTH_FOR_AI = 10000; // Maximum characters to send to OpenAI
const AI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini'; // Configurable AI model

// When a *third-party provider key* (OpenAI/Anthropic) submitted or configured by
// the admin fails the provider's own authentication, that is NOT a failure of the
// admin's GrantFlow session — so it must NOT be reported as HTTP 401. The frontend
// API client (src/api/client.js) treats any 401 as "your session expired" and will
// trigger a token refresh / sign-out and spam the console with red 401s. 422
// (Unprocessable Entity) correctly says "we authenticated you fine, but the
// provider credential you gave us is unusable" without tripping that machinery.
// DO NOT change this back to 401.
const PROVIDER_AUTH_FAILURE_STATUS = 422;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRootDir = join(__dirname, '..', '..');
function getUploadsDir(req) {
  const fromApp = req?.app?.locals?.uploads?.uploadsDir
  if (fromApp) return String(fromApp)
  if (req?.uploadsDir) return String(req.uploadsDir)
  const resolvedDirs = resolveUploadsDir({ baseDir: join(__dirname, '..') })
  return resolvedDirs.uploadsDir
}

function requireUploadsWritable(req, res, next) {
  const status = req?.storageStatus || req?.app?.locals?.uploads?.storageStatus || null
  if (status && status.writable === false) {
    return res.status(503).json({
      ok: false,
      error: 'Upload storage is unavailable',
      code: 'UPLOAD_STORAGE_UNAVAILABLE',
      uploads_dir: status.uploads_dir || null,
      status: status.status || 'degraded',
    })
  }
  return next()
}

// Geo datasets are optional. If present, we use them to power ZIP-scoped crawls.
// If absent, we still return a usable state list so the Geo Crawl UI can run state-wide crawls.
const zipCoordinatesPath = process.env.GEO_ZIP_COORDINATES_PATH
  ? resolve(process.env.GEO_ZIP_COORDINATES_PATH)
  : join(repoRootDir, 'backend', 'data', 'crawlers', 'zip_coordinates.json');
function resolveCountiesDatasetPath() {
  const configured = process.env.GEO_COUNTIES_BY_STATE_PATH
    ? resolve(process.env.GEO_COUNTIES_BY_STATE_PATH)
    : null
  if (configured && fs.existsSync(configured)) return configured

  // Common fallback locations (repo root vs backend/data). Prefer backend-scoped path.
  const candidates = [
    join(repoRootDir, 'backend', 'data', 'crawlers', 'county_batch1.json'),
    join(repoRootDir, 'backend', 'data', 'crawlers', 'counties_by_state.json'),
    join(repoRootDir, 'county_batch1.json'),
  ]
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {
      // ignore
    }
  }
  return configured || candidates[0]
}

const countiesByStatePath = resolveCountiesDatasetPath();

let zipCoordinatesCache = null;
let zipStateIndexCache = null;
let countiesByStateCache = null;
let countiesByStateFromFile = false;
let zipCoordinatesMissing = false;
// Some deployments accidentally package a tiny `zip_coordinates.json` (hundreds of ZIPs).
// Geo Crawl must support the full US ZIP set; treat undersized datasets as "missing" and fall back to `zipcodes`.
const MIN_ZIP_COORDINATES_ROWS = Number(process.env.GEO_MIN_ZIP_COORDINATES || 30_000)

const STATE_FIPS = Object.freeze({
  AL: '01', AK: '02', AZ: '04', AR: '05', CA: '06', CO: '08', CT: '09', DE: '10', DC: '11',
  FL: '12', GA: '13', HI: '15', ID: '16', IL: '17', IN: '18', IA: '19', KS: '20', KY: '21',
  LA: '22', ME: '23', MD: '24', MA: '25', MI: '26', MN: '27', MS: '28', MO: '29', MT: '30',
  NE: '31', NV: '32', NH: '33', NJ: '34', NM: '35', NY: '36', NC: '37', ND: '38', OH: '39',
  OK: '40', OR: '41', PA: '42', RI: '44', SC: '45', SD: '46', TN: '47', TX: '48', UT: '49',
  VT: '50', VA: '51', WA: '53', WV: '54', WI: '55', WY: '56',
})

const US_STATE_CODES = Object.freeze([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA',
  'HI','ID','IL','IN','IA','KS','KY','LA','ME','MD',
  'MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC',
  'SD','TN','TX','UT','VT','VA','WA','WV','WI','WY',
  'DC',
]);

const CRAWLER_AUDIT_TYPES = [
  'curated_benefits',
  'item_matching',
];

function nowIso() {
  return new Date().toISOString();
}

async function withTimeout(promise, ms, label) {
  let timeoutId = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const err = new Error(`${label} timed out after ${ms}ms`);
      err.code = 'TIMEOUT';
      reject(err);
    }, ms);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

// Use centralized admin enforcement from accessControl.js
// This is now just an alias for consistency with existing code
const ensureAdminRequest = ensureAdminUser;

// Router-level admin auth middleware (defense-in-depth).
// Individual handlers keep their own checks; this ensures every route on
// this router requires admin authentication even if a check is missed.
router.use(async (req, res, next) => {
  try {
    const allowed = await ensureAdminUser(req, res);
    if (allowed) next();
  } catch (err) {
    next(err);
  }
});

// ----------------------------
// Funding Providers (no secrets)
// ----------------------------
router.get('/funding-sources', async (req, res) => {
  if (!(await ensureAdminRequest(req, res))) return
  res.json({ sources: getFundingSourceStatus() })
})

// ----------------------------
// Audit Events (durable DB-backed)
// ----------------------------
router.get('/audit-events', async (req, res) => {
  if (!(await ensureAdminRequest(req, res))) return

  try {
    const limit = Math.max(1, Math.min(Number(req.query?.limit) || 200, 200))
    const type = typeof req.query.type === 'string' ? req.query.type.trim() : ''

    // Fetch a larger window then filter by prefix to support "type" queries.
    const raw = await queryAuditLogs(req.db, {
      category: AUDIT_CATEGORIES.ANYA,
      limit: 500,
      offset: 0,
    })

    let logs = raw?.logs || []

    if (type === 'autonomous_crawler') {
      logs = logs.filter((l) => String(l.action || '').startsWith('autonomous.'))
    } else if (type === 'autonomous_crawlers') {
      logs = logs.filter((l) => String(l.action || '').startsWith('autonomous_crawlers.'))
    } else if (type === 'autonomous_scheduler') {
      logs = logs.filter((l) => String(l.action || '').startsWith('autonomous_scheduler.'))
    } else if (type === 'route_generation') {
      logs = logs.filter((l) => String(l.action || '').startsWith('route_generation.'))
    } else if (type) {
      // Generic prefix filter (admin-only endpoint).
      logs = logs.filter((l) => String(l.action || '').startsWith(type))
    }

    res.json({
      type: type || null,
      limit,
      audit_events: logs.slice(0, limit),
    })
  } catch (error) {
    console.error('[admin/audit-events]', error)
    res.status(500).json({ error: error?.message || 'Failed to load audit events' })
  }
})

router.get('/matching/low-coverage-events', async (req, res) => {
  if (!(await ensureAdminRequest(req, res))) return
  try {
    const limit = Math.max(1, Math.min(Number(req.query?.limit) || 100, 500))
    const rows = await req.db.prepare(`
      SELECT profile_id, search_terms, free_text, qualified_count, min_score,
             intent_label, branded_program, recorded_at
      FROM matching_low_coverage_events
      ORDER BY recorded_at DESC
      LIMIT ?
    `).all(limit)
    const events = (rows || []).map((row) => ({
      ...row,
      search_terms: (() => {
        try { return JSON.parse(row.search_terms || '[]') } catch { return [] }
      })(),
    }))
    res.json({ count: events.length, events })
  } catch (error) {
    res.json({ count: 0, events: [], note: 'matching_low_coverage_events table not initialized yet' })
  }
})

/**
 * GET /api/admin/storage/uploads-check
 * Admin-only: verifies uploadsDir is writable and samples avatar/doc file existence.
 */
router.get('/storage/uploads-check', async (req, res) => {
  if (!(await ensureAdminRequest(req, res))) return

  const uploadsDir = getUploadsDir(req)
  const legacyUploadsDir =
    (req?.app?.locals?.uploads?.legacyUploadsDir ? String(req.app.locals.uploads.legacyUploadsDir) : null) ||
    (req?.legacyUploadsDir ? String(req.legacyUploadsDir) : null)

  const writableCheck = uploadsDir ? await ensureUploadsDirWritable(uploadsDir) : { ok: false, error: 'uploads_not_configured' }

  let fileCount = null
  try {
    const entries = uploadsDir ? await fsp.readdir(uploadsDir) : []
    fileCount = Array.isArray(entries) ? entries.length : null
  } catch {
    fileCount = null
  }

  const extractUploadsFilename = (value) => {
    const raw = typeof value === 'string' ? value : ''
    const idx = raw.lastIndexOf('/uploads/')
    if (idx === -1) return null
    const tail = raw.slice(idx + '/uploads/'.length)
    const file = tail.split('?')[0].split('#')[0].replace(/^\/+/, '').trim()
    return file || null
  }

  const existsInUploads = (filename) => {
    if (!filename) return false
    try {
      if (uploadsDir && fs.existsSync(join(uploadsDir, filename))) return true
    } catch {
      // ignore fs probing errors
    }
    try {
      if (legacyUploadsDir && fs.existsSync(join(legacyUploadsDir, filename))) return true
    } catch {
      // ignore fs probing errors
    }
    return false
  }

  const sample = []
  try {
    const avatarRows = await req.db
      .prepare("SELECT id, avatar_url, updated_at FROM profiles WHERE avatar_url LIKE '/uploads/%' ORDER BY updated_at DESC LIMIT 10")
      .all()
    for (const row of avatarRows || []) {
      const filename = extractUploadsFilename(row?.avatar_url)
      sample.push({
        type: 'avatar',
        id: String(row?.id || ''),
        url: row?.avatar_url || null,
        exists: existsInUploads(filename),
      })
    }
  } catch {
    // ignore missing tables / query failures in drifted environments
  }

  try {
    const docRows = await req.db
      .prepare(
        `
          SELECT id, file_url, file_path, updated_at
          FROM documents
          WHERE (file_url LIKE '%/uploads/%' OR file_path LIKE '%uploads%')
          ORDER BY updated_at DESC
          LIMIT 10
        `,
      )
      .all()
    for (const row of docRows || []) {
      const filename = extractUploadsFilename(row?.file_url) || extractUploadsFilename(row?.file_path)
      sample.push({
        type: 'document',
        id: String(row?.id || ''),
        url: row?.file_url || row?.file_path || null,
        exists: existsInUploads(filename),
      })
    }
  } catch {
    // ignore missing tables / query failures in drifted environments
  }

  return res.status(writableCheck?.ok ? 200 : 503).json({
    ok: Boolean(writableCheck?.ok),
    uploadsDir,
    legacyUploadsDir,
    writable: Boolean(writableCheck?.ok),
    last_error: writableCheck?.ok ? null : (writableCheck?.error || null),
    fileCount,
    sampleExistsCheck: sample,
    timestamp: new Date().toISOString(),
  })
})

function loadZipCoordinates() {
  if (zipCoordinatesCache) return zipCoordinatesCache;
  if (!fs.existsSync(zipCoordinatesPath)) {
    // In some production builds this dataset may not be packaged.
    // The Geo Crawl UI should degrade gracefully instead of 500'ing.
    zipCoordinatesMissing = true;
    zipCoordinatesCache = {};
    return zipCoordinatesCache;
  }
  try {
    zipCoordinatesCache = JSON.parse(fs.readFileSync(zipCoordinatesPath, 'utf8'));
    // If the dataset is present but incomplete, force fallback to `zipcodes` (all US ZIP codes).
    try {
      const size = Object.keys(zipCoordinatesCache || {}).length
      if (size > 0 && size < MIN_ZIP_COORDINATES_ROWS) {
        console.warn('[admin/geo] zip_coordinates dataset looks incomplete; falling back to zipcodes', {
          zipCoordinatesPath,
          size,
          minRequired: MIN_ZIP_COORDINATES_ROWS,
        })
        zipCoordinatesMissing = true
        zipCoordinatesCache = {}
      }
    } catch {
      // ignore sizing issues
    }
  } catch (error) {
    zipCoordinatesMissing = true;
    zipCoordinatesCache = {};
  }
  return zipCoordinatesCache;
}

function buildZipStateIndex() {
  if (zipStateIndexCache) return zipStateIndexCache;
  const coords = loadZipCoordinates();
  const index = new Map();

  // Production-safe fallback: if `zip_coordinates.json` isn't packaged, rely on `zipcodes`.
  if (zipCoordinatesMissing) {
    for (const state of US_STATE_CODES) {
      const entries = (zipcodes.lookupByState(state) || [])
        .map((row) => ({
          zip_code: row?.zip ?? null,
          city: row?.city ?? null,
          state: row?.state ?? state,
          lat: row?.latitude ?? null,
          lng: row?.longitude ?? null,
        }))
        .filter((row) => row.zip_code);
      // Stable order for consistent UI + deterministic selection.
      entries.sort((a, b) => String(a.zip_code).localeCompare(String(b.zip_code)))
      if (entries.length > 0) index.set(state, entries);
    }
    zipStateIndexCache = index;
    return zipStateIndexCache;
  }

  for (const [zip, meta] of Object.entries(coords)) {
    const state = meta?.state;
    if (!state) continue;
    if (!index.has(state)) index.set(state, []);
    index.get(state).push({
      zip_code: zip,
      city: meta.city ?? null,
      state,
      lat: meta.lat ?? null,
      lng: meta.lng ?? null,
    });
  }

  // Sort ZIPs within each state for stable UX.
  for (const entries of index.values()) {
    entries.sort((a, b) => String(a.zip_code).localeCompare(String(b.zip_code)));
  }

  zipStateIndexCache = index;
  return zipStateIndexCache;
}

function loadCountiesByState() {
  // Reuse a real, file-backed dataset once we've loaded one.
  if (countiesByStateFromFile && countiesByStateCache) return countiesByStateCache;
  // Re-resolve the path each call WHILE we lack file data, so a dataset written
  // AFTER boot (e.g. by the warmCountyCache startup task on Railway's ephemeral
  // FS) is picked up without a restart.
  const datasetPath = resolveCountiesDatasetPath();
  if (fs.existsSync(datasetPath)) {
    try {
      countiesByStateCache = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));
      countiesByStateFromFile = true;
      return countiesByStateCache;
    } catch (err) {
      console.warn('[admin] Failed to parse counties data:', err.message);
    }
  }
  // No file yet — keep a persistent object so per-state computed results still
  // cache across requests within this process (do NOT cache a negative result).
  if (!countiesByStateCache) countiesByStateCache = {};
  return countiesByStateCache;
}

async function fetchCountiesFromCensus(stateCode) {
  const st = String(stateCode || '').toUpperCase()
  const fips = STATE_FIPS[st] || null
  if (!fips) return []

  // No API key required.
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 12_000)
  try {
    const url = `https://api.census.gov/data/2019/pep/population?get=NAME&for=county:*&in=state:${encodeURIComponent(fips)}`
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) return []
    const data = await res.json().catch(() => null)
    if (!Array.isArray(data) || data.length < 2) return []

    const names = data
      .slice(1)
      .map((row) => (Array.isArray(row) ? String(row[0] || '') : ''))
      .map((name) => name.split(',')[0].trim())
      .filter(Boolean)

    return Array.from(new Set(names)).sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  } finally {
    clearTimeout(timeoutId)
  }
}

const storage = multer.diskStorage({
  destination: (req, _file, cb) => cb(null, getUploadsDir(req)),
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    // The client-supplied originalname is untrusted. Taking the raw
    // "last dot-separated segment" as the extension lets a name with no dot
    // AFTER a slash (e.g. "x.tar/../../evil") smuggle "/" and ".." into the
    // generated filename, which multer then joins onto the uploads dir
    // (path injection). Strip everything but safe filename characters and
    // cap the length so the extension can never carry a path separator.
    const rawExtension = file.originalname.includes('.') ? file.originalname.split('.').pop() : '';
    const extension = rawExtension ? `.${String(rawExtension).replace(/[^a-zA-Z0-9]/g, '').slice(0, 10)}` : '';
    cb(null, `admin-upload-${unique}${extension}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'));
    }
  },
});

// Knowledge Base uploads (global reference docs; not tied to a profile).
const KB_MAX_FILE_BYTES = 50 * 1024 * 1024
const KB_ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/html',
  'application/xhtml+xml',
  'application/rtf',
  'text/rtf',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/tiff',
  'image/heic',
  'image/heif',
])
const KB_ALLOWED_EXTENSIONS = new Set([
  'pdf',
  'doc',
  'docx',
  'txt',
  'html',
  'htm',
  'rtf',
  'jpg',
  'jpeg',
  'png',
  'webp',
  'gif',
  'bmp',
  'tif',
  'tiff',
  'heic',
  'heif',
])

function kbMulterFileFilter(_req, file, cb) {
  const extension = (file?.originalname?.split('.').pop() || '').toLowerCase()
  const ok = KB_ALLOWED_MIME_TYPES.has(file?.mimetype) || KB_ALLOWED_EXTENSIONS.has(extension)
  if (!ok) return cb(new Error('Unsupported file type'))
  return cb(null, true)
}

const knowledgeUpload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => cb(null, getUploadsDir(req)),
    filename: (_req, file, cb) => {
      const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`
      // See the admin-upload storage config above: sanitize the client-supplied
      // extension so it can never carry a path separator into the generated name.
      const rawExtension = file.originalname.includes('.') ? file.originalname.split('.').pop() : ''
      const extension = rawExtension ? `.${String(rawExtension).replace(/[^a-zA-Z0-9]/g, '').slice(0, 10)}` : ''
      cb(null, `kb-${unique}${extension}`)
    },
  }),
  fileFilter: kbMulterFileFilter,
  limits: { fileSize: KB_MAX_FILE_BYTES },
})

// Helper function to extract text from PDF
async function extractTextFromPDF(filePath) {
  try {
    const buffer = await fsp.readFile(filePath);
    const result = await pdfParse(buffer);
    const text = result?.text?.trim();
    return text && text.length > 0 ? text : null;
  } catch (error) {
    console.warn('PDF text extraction failed', { filePath, error });
    return null;
  }
}

// Helper function to get OpenAI instance
function getOpenAI() {
  return createOpenAIClient().openai;
}

function getOpenAIOptional() {
  return createOpenAIClient({ allowMissing: true }).openai
}

async function createAnthropicClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null
  const Anthropic = (await import('@anthropic-ai/sdk')).default
  return new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    timeout: Number(process.env.ANYA_ANTHROPIC_TIMEOUT_MS || 15_000),
    maxRetries: Number(process.env.ANYA_ANTHROPIC_MAX_RETRIES || 1),
  })
}

function extractAnthropicText(response) {
  const parts = Array.isArray(response?.content) ? response.content : []
  return parts
    .map((part) => (typeof part?.text === 'string' ? part.text : typeof part === 'string' ? part : ''))
    .filter(Boolean)
    .join('\n')
    .trim()
}

// Normalize what an admin types into the "Ingest by URL" box into the https
// URL the SSRF-safe fetcher requires. A bare domain ("example.org/grants") gets
// the https scheme prepended, and http:// is upgraded to https:// (the fetcher
// refuses plain http outright, so the upgrade is the only way the URL can
// work). Any other explicit scheme is left alone so the fetcher can refuse it
// with an honest reason.
function normalizeKnowledgeIngestUrl(raw) {
  let value = safeTrim(raw)
  if (!value) return ''
  if (/^http:\/\//i.test(value)) return `https://${value.slice('http://'.length)}`
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return `https://${value}`
  return value
}

// Turn a safeRemoteFetch failure into a message an admin can act on. The bare
// reason tokens ("unsupported_content_type") told the owner nothing.
function describeKnowledgeFetchFailure(remote = {}) {
  const reason = String(remote?.reason || '')
  switch (reason) {
    case 'unsupported_content_type':
      return `That URL returned "${remote?.contentType || 'an unknown content type'}", which is not a supported document type. Ingest a web page (HTML) or a direct link to a PDF, Word, text, RTF, or image file.`
    case 'response_too_large':
      return `The file at that URL is larger than the ${Math.round(KB_MAX_FILE_BYTES / (1024 * 1024))}MB ingest limit.`
    case 'timeout':
      return 'The remote server took too long to respond. Try again, or download the file and upload it directly.'
    case 'http_error':
      return `The remote server responded with HTTP ${remote?.status || 'error'} for that URL. Check that the link is public and still valid.`
    case 'https_required':
      return 'Only public https:// URLs can be ingested. The site does not appear to support https.'
    case 'unparseable':
    case 'empty':
      return 'That does not look like a valid URL. Paste a full web address such as https://example.org/grants.'
    case 'private_host':
    case 'dns_resolves_private':
      return 'That URL points at a private or internal address, which cannot be ingested.'
    case 'embedded_credentials':
      return 'URLs with embedded credentials (user:pass@) cannot be ingested.'
    case 'too_many_redirects':
      return 'The URL redirected too many times. Try the final destination URL directly.'
    default:
      if (reason.startsWith('bad_protocol:')) {
        return `Unsupported URL scheme "${reason.slice('bad_protocol:'.length)}". Only https:// URLs can be ingested.`
      }
      if (reason.startsWith('dns_error:') || reason === 'dns_no_records') {
        return 'That domain could not be found (DNS lookup failed). Check the address for typos.'
      }
      return `Unable to download that URL: ${reason || 'fetch failed'}.`
  }
}

const KB_HTML_CONTENT_TYPES = new Set(['text/html', 'application/xhtml+xml'])

function extractHtmlTitle(html) {
  const match = /<title[^>]*>([\s\S]{0,500}?)<\/title>/i.exec(String(html || '').slice(0, 200_000))
  if (!match) return null
  const title = match[1]
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return title || null
}

async function downloadRemoteFileToUploads({ url, req }) {
  const remote = await fetchPublicResource(url, {
    timeoutMs: 20_000,
    maxBytes: KB_MAX_FILE_BYTES,
    allowedContentTypes: [...KB_ALLOWED_MIME_TYPES, 'application/octet-stream'],
    userAgent: 'GrantFlow Knowledge Ingest (+https://app.axiombiolabs.org)',
    accept: 'text/html,application/xhtml+xml,application/pdf,text/plain,application/octet-stream;q=0.8,*/*;q=0.5',
  })
  if (!remote.ok) {
    const error = new Error(describeKnowledgeFetchFailure(remote))
    error.status = publicFetchFailureStatus(remote)
    error.code = `REMOTE_FETCH_${String(remote.reason || 'FAILED').toUpperCase()}`
    throw error
  }

  let contentType = remote.contentType || 'application/octet-stream'
  if (contentType === 'application/octet-stream') {
    if (remote.body.length < 5 || remote.body.subarray(0, 5).toString('ascii') !== '%PDF-') {
      const error = new Error(
        'The remote server did not say what kind of file that is, and it is not a PDF. Download the file and upload it directly instead.',
      )
      error.status = 415
      error.code = 'REMOTE_DOCUMENT_TYPE_UNVERIFIED'
      throw error
    }
    contentType = 'application/pdf'
  }
  const isHtml = KB_HTML_CONTENT_TYPES.has(contentType)
  const pageTitle = isHtml ? extractHtmlTitle(remote.body.toString('utf8')) : null
  const fileNameFromUrl = (() => {
    try {
      const parsed = new URL(remote.finalUrl || url)
      return parsed.pathname.split('/').pop() || 'remote-upload'
    } catch {
      return 'remote-upload'
    }
  })()

  const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`
  const candidateExtension = fileNameFromUrl.includes('.')
    ? fileNameFromUrl.split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '')
    : ''
  const safeExtension = KB_ALLOWED_EXTENSIONS.has(candidateExtension)
    ? candidateExtension
    : contentType === 'application/pdf'
      ? 'pdf'
      : isHtml
        ? 'html'
        : ''
  const extension = safeExtension ? `.${safeExtension}` : ''
  const filename = `kb-${unique}${extension}`
  const absPath = join(getUploadsDir(req), filename)

  await fsp.writeFile(absPath, remote.body)

  return {
    file: {
      path: absPath,
      size: remote.body.length,
      mimetype: contentType,
      originalname: fileNameFromUrl,
      filename,
    },
    publicUrl: `/uploads/${filename}`,
    pageTitle,
    finalUrl: remote.finalUrl || url,
  }
}

function tryExtractFirstJson(text) {
  const raw = String(text || '')
  const jsonMatch = raw.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return null
  try {
    return JSON.parse(jsonMatch[0])
  } catch {
    return null
  }
}

async function invokeJsonWithFallback({ system, prompt, maxTokens = 1500, temperature = 0.1 } = {}) {
  const openai = getOpenAIOptional()
  if (openai) {
    try {
      const completion = await openai.chat.completions.create({
        model: AI_MODEL,
        messages: [
          system ? { role: 'system', content: system } : null,
          { role: 'user', content: prompt },
        ].filter(Boolean),
        response_format: { type: 'json_object' },
        temperature,
        max_tokens: maxTokens,
      })

      const raw = completion.choices?.[0]?.message?.content
      if (raw) {
        try {
          return { json: JSON.parse(raw), provider: 'openai', raw }
        } catch {
          const extracted = tryExtractFirstJson(raw)
          if (extracted) return { json: extracted, provider: 'openai', raw }
        }
      }
    } catch (error) {
      const summary = summarizeOpenAIError(error)
      console.warn('[admin/ai] OpenAI failed, will try Anthropic:', summary?.message || error?.message || error)
    }
  }

  const anthropic = await createAnthropicClient()
  if (anthropic) {
    try {
      const response = await anthropic.messages.create({
        model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5',
        max_tokens: maxTokens,
        temperature,
        system: system || undefined,
        messages: [
          {
            role: 'user',
            content:
              `${prompt}\n\n` +
              `Return ONLY a valid JSON object. Do not include markdown fences or commentary.`,
          },
        ],
      })

      const raw = extractAnthropicText(response)
      const extracted = tryExtractFirstJson(raw)
      if (extracted) return { json: extracted, provider: 'anthropic', raw }
    } catch (error) {
      console.warn('[admin/ai] Anthropic failed:', error?.message || error)
    }
  }

  return { json: null, provider: 'fallback', raw: null }
}

// GET /api/admin/openai/verify
// Verifies that the server-side OpenAI key is present and can successfully call the API.
router.get('/openai/verify', async (req, res) => {
  if (!(await ensureAdminRequest(req, res))) return;

  // "Not configured" is a valid verification result, not a server error. Build
  // the client with allowMissing so a missing key returns a 200 with
  // configured:false instead of throwing → 500 (which the endpoint sweep flags).
  const { openai, diagnostics } = createOpenAIClient({ allowMissing: true });
  if (!openai) {
    return res.json({
      ok: false,
      configured: false,
      diagnostics,
      hint: 'Server-side OpenAI key is not set. Set OPENAI_API_KEY on the backend process (not the frontend) and restart the server.',
    });
  }

  try {
    // A lightweight call that should succeed with a valid key.
    const models = await openai.models.list();
    const first = Array.isArray(models?.data) ? models.data[0]?.id : null;
    res.json({
      ok: true,
      configured: true,
      diagnostics,
      sample_model: first,
      model_count: Array.isArray(models?.data) ? models.data.length : null,
    });
  } catch (error) {
    const summary = summarizeOpenAIError(error);
    res.status(summary.isAuth ? PROVIDER_AUTH_FAILURE_STATUS : 500).json({
      ok: false,
      error: summary.message,
      status: summary.status ?? null,
      diagnostics,
      hint: summary.isAuth
        ? 'Server-side OpenAI key failed authentication. Double-check OPENAI_API_KEY on the backend process (not the frontend), and restart the server after changing it.'
        : 'OpenAI verification failed. Check outbound network/DNS/firewall and try again.',
    });
  }
});

// POST /api/admin/openai/verify-key
// Verifies a key provided in the request body (one-off), without saving it to env or disk.
// Body: { "apiKey": "sk-..." }
router.post('/openai/verify-key', async (req, res) => {
  if (!(await ensureAdminRequest(req, res))) return;

  const apiKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim() : '';
  if (!apiKey) {
    return res.status(400).json({
      ok: false,
      error: 'Missing apiKey',
      message: 'Provide { apiKey: "sk-..." } in the JSON body',
    });
  }

  try {
    const { openai, diagnostics } = createOpenAIClient({ apiKeyOverride: apiKey });
    const models = await openai.models.list();
    const first = Array.isArray(models?.data) ? models.data[0]?.id : null;
    res.json({
      ok: true,
      diagnostics,
      sample_model: first,
      model_count: Array.isArray(models?.data) ? models.data.length : null,
    });
  } catch (error) {
    const summary = summarizeOpenAIError(error);
    // Diagnostics for the provided key (redacted)
    const { diagnostics } = createOpenAIClient({ allowMissing: true, apiKeyOverride: apiKey });
    res.status(summary.isAuth ? PROVIDER_AUTH_FAILURE_STATUS : 500).json({
      ok: false,
      error: summary.message,
      status: summary.status ?? null,
      diagnostics,
      hint: summary.isAuth
        ? 'Provided key failed authentication. Copy only the raw OpenAI key (no "OPENAI_API_KEY=" prefix, no extra platform text), then try again.'
        : 'Verification failed. Check outbound network/DNS/firewall and try again.',
    });
  }
});

// POST /api/admin/openai/apply-key
// Applies a provided OpenAI key to the *running process* (in-memory) and verifies immediately.
// This avoids env-var tooling/restarts for local/dev use. It does NOT persist across restarts.
// Body: { "apiKey": "sk-..." }
router.post('/openai/apply-key', async (req, res) => {
  if (!(await ensureAdminRequest(req, res))) return;

  const apiKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim() : '';
  const persist = Boolean(req.body?.persist);
  if (!apiKey) {
    return res.status(400).json({
      ok: false,
      error: 'Missing apiKey',
      message: 'Provide { apiKey: "sk-..." } in the JSON body',
    });
  }

  // Apply to process env (in-memory). openaiClient normalization will strip common junk.
  process.env.OPENAI_API_KEY = apiKey;

  // Optionally persist encrypted value into DB so it can be restored on restart.
  // This is an emergency override mechanism; do not rely on it long-term.
  if (persist) {
    try {
      const encrypted = encryptRuntimeSecret(apiKey);
      await req.db
        .prepare(
          `
            INSERT INTO app_runtime_secrets (key, value_ciphertext, iv, tag, updated_at)
            VALUES ('OPENAI_API_KEY', ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(key) DO UPDATE SET
              value_ciphertext = excluded.value_ciphertext,
              iv = excluded.iv,
              tag = excluded.tag,
              updated_at = CURRENT_TIMESTAMP
          `,
        )
        .run(encrypted.value_ciphertext, encrypted.iv, encrypted.tag);
    } catch (e) {
      console.warn('[admin/openai/apply-key] Failed to persist runtime secret:', e?.message || e);
    }
  }

  try {
    const { openai, diagnostics } = createOpenAIClient();
    const models = await openai.models.list();
    const first = Array.isArray(models?.data) ? models.data[0]?.id : null;

    res.json({
      ok: true,
      applied: true,
      persisted: persist,
      diagnostics,
      sample_model: first,
      model_count: Array.isArray(models?.data) ? models.data.length : null,
      note: persist
        ? 'Key applied and persisted to DB for emergency restart recovery. Please set OPENAI_API_KEY in your host environment for a permanent fix.'
        : 'Key applied to running process only (not persisted). To persist, set OPENAI_API_KEY in your host environment.',
    });
  } catch (error) {
    const summary = summarizeOpenAIError(error);
    const { diagnostics } = createOpenAIClient({ allowMissing: true });

    res.status(summary.isAuth ? PROVIDER_AUTH_FAILURE_STATUS : 500).json({
      ok: false,
      applied: true,
      persisted: persist,
      error: summary.message,
      status: summary.status ?? null,
      diagnostics,
      hint: summary.isAuth
        ? 'Applied key failed authentication. Ensure you pasted the raw OpenAI key (sk-...) with no extra text.'
        : 'Applied key verification failed. Check outbound network/DNS/firewall and try again.',
    });
  }
});

// POST /api/admin/env/apply
// Applies an allowlisted env var to the *running process* (in-memory).
// Optionally persists encrypted values for secret keys into DB (emergency override; not a replacement for real env config).
// Body: { "key": "RESEND_API_KEY", "value": "...", "persist": true|false }
router.post('/env/apply', async (req, res) => {
  if (!(await ensureAdminRequest(req, res))) return;

  const key = typeof req.body?.key === 'string' ? req.body.key.trim() : '';
  const valueRaw = req.body?.value;
  const value = (valueRaw === null || valueRaw === undefined) ? '' : String(valueRaw);
  const persist = Boolean(req.body?.persist);

  if (!key || !/^[A-Z0-9_]+$/.test(key)) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid key',
      message: 'key must be a non-empty string matching /^[A-Z0-9_]+$/',
    });
  }

  const ALLOWLIST = new Set([
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'RESEND_API_KEY',
    'FROM_EMAIL',
    'AUTH_NOTIFY_ON_LOGIN',
    'AUTH_NOTIFY_EMAIL',
    'ANYA_ADMIN_TOKEN',
    'SAM_GOV_PUBLIC_API_KEY',
    'GRANTS_GOV_API_KEY',
    'SIMPLER_GRANTS_API_KEY',
    'API_DATA_GOV_KEY',
    'AUTH_PUBLIC_URL',
    'AUTH_FRONTEND_URL',
  ]);

  const SECRET_KEYS = new Set([
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'RESEND_API_KEY',
    'ANYA_ADMIN_TOKEN',
    // Funding provider keys should be treated as secrets too.
    'SAM_GOV_PUBLIC_API_KEY',
    'GRANTS_GOV_API_KEY',
    'SIMPLER_GRANTS_API_KEY',
    'API_DATA_GOV_KEY',
  ]);

  if (!ALLOWLIST.has(key)) {
    return res.status(403).json({
      ok: false,
      error: 'Key not allowed',
      message: `Editing ${key} is not permitted from this endpoint.`,
    });
  }

  // Apply to process env (in-memory). Empty string clears.
  if (value.trim() === '') {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }

  let persisted = false;
  if (persist && SECRET_KEYS.has(key)) {
    try {
      if (value.trim() === '') {
        await req.db.prepare(`DELETE FROM app_runtime_secrets WHERE key = ?`).run(key);
        persisted = true;
      } else {
        const encrypted = encryptRuntimeSecret(value);
        await req.db
          .prepare(
            `
              INSERT INTO app_runtime_secrets (key, value_ciphertext, iv, tag, updated_at)
              VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
              ON CONFLICT(key) DO UPDATE SET
                value_ciphertext = excluded.value_ciphertext,
                iv = excluded.iv,
                tag = excluded.tag,
                updated_at = CURRENT_TIMESTAMP
            `,
          )
          .run(key, encrypted.value_ciphertext, encrypted.iv, encrypted.tag);
        persisted = true;
      }
    } catch (e) {
      console.warn('[admin/env/apply] Failed to persist runtime secret:', e?.message || e);
    }
  }

  res.json({
    ok: true,
    key,
    applied: true,
    cleared: value.trim() === '',
    persisted,
    note: persisted
      ? 'Applied to running process and persisted (encrypted) to DB for emergency restart recovery.'
      : 'Applied to running process only (not persisted). For permanent config, set it in your host environment.',
  });
});

// ----------------------------
// Knowledge Base (global docs)
// ----------------------------
const KB_DOCUMENT_TYPE = 'knowledge'

function clampInt(value, { min, max, fallback }) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  const i = Math.floor(n)
  return Math.max(min, Math.min(max, i))
}

function safeTrim(value) {
  const s = (value === null || value === undefined) ? '' : String(value)
  const t = s.trim()
  return t ? t : ''
}

function safeDeleteFile(req, filePath) {
  try {
    const raw = safeTrim(filePath)
    if (!raw) return false
    const resolved = resolve(raw)
    const base = resolve(getUploadsDir(req))
    if (!resolved.startsWith(base)) return false
    if (!fs.existsSync(resolved)) return false
    fs.unlinkSync(resolved)
    return true
  } catch {
    return false
  }
}

// Helper to trigger KB document AI analysis asynchronously
function triggerKBAnalysis(db, docId, extractedText) {
  if (extractedText && extractedText.trim().length > 50) {
    // Run analysis asynchronously - don't block the response
    analyzeKnowledgeBaseDocument({
      documentId: docId,
      extractedText,
      db,
    }).catch(error => {
      console.error('[KB Upload] AI analysis failed for', docId, error)
    })
  }
}

// GET /api/admin/knowledge
// Query params: q, limit, offset
router.get('/knowledge', async (req, res) => {
  if (!(await ensureAdminRequest(req, res))) return
  try {
    const q = safeTrim(req.query?.q)
    const limit = clampInt(req.query?.limit, { min: 1, max: 200, fallback: 50 })
    const offset = clampInt(req.query?.offset, { min: 0, max: 50_000, fallback: 0 })

    const isPg = req.db?.dialect === 'postgres'
    const like = isPg ? 'ILIKE' : 'LIKE'
    const where = [`type = ?`]
    const params = [KB_DOCUMENT_TYPE]

    if (q) {
      where.push(`(name ${like} ? OR notes ${like} ? OR extracted_text ${like} ?)`)
      const needle = `%${q}%`
      params.push(needle, needle, needle)
    }

    const rows = await req.db
      .prepare(
        `
          SELECT id, created_at, updated_at, name, type, file_url, file_size, mime_type, processing_status, notes
          FROM documents
          WHERE ${where.join(' AND ')}
          ORDER BY created_at DESC
          LIMIT ?
          OFFSET ?
        `,
      )
      .all(...params, limit, offset)

    res.json({ ok: true, q: q || null, limit, offset, items: rows || [] })
  } catch (error) {
    res.status(500).json({ ok: false, error: error?.message || String(error) })
  }
})

// GET /api/admin/knowledge/:id
router.get('/knowledge/:id', async (req, res) => {
  if (!(await ensureAdminRequest(req, res))) return
  try {
    const id = safeTrim(req.params?.id)
    const doc = await req.db
      .prepare(`SELECT * FROM documents WHERE id = ? AND type = ? LIMIT 1`)
      .get(id, KB_DOCUMENT_TYPE)
    if (!doc) return res.status(404).json({ ok: false, error: 'Not found' })
    res.json({ ok: true, document: doc })
  } catch (error) {
    res.status(500).json({ ok: false, error: error?.message || String(error) })
  }
})

// POST /api/admin/knowledge/upload
// multipart/form-data: document=<file>, name?, notes?, ocr?, handwriting?, ocr_language?
router.post('/knowledge/upload', knowledgeUpload.single('document'), async (req, res) => {
  if (!(await ensureAdminRequest(req, res))) {
    if (req.file?.path) safeDeleteFile(req, req.file.path)
    return
  }
  try {
    const file = req.file
    if (!file) return res.status(400).json({ ok: false, error: 'document file is required' })

    const name = safeTrim(req.body?.name) || safeTrim(file.originalname) || 'Knowledge Document'
    const notes = safeTrim(req.body?.notes) || null

    let extractedText = null
    try {
      const ocr = req.body?.ocr === 'true' || req.body?.ocr === true
      const handwriting = req.body?.handwriting === 'true' || req.body?.handwriting === true
      const ocrLanguage = safeTrim(req.body?.ocr_language) || 'eng'
      const result = await extractTextFromFile({
        filePath: file.path,
        baseDir: getUploadsDir(req),
        mimeType: file.mimetype,
        fileName: file.originalname,
        ocr,
        handwriting,
        ocrLanguage,
      })
      extractedText = result?.text ?? null
    } catch {
      extractedText = null
    }

    const docId = crypto.randomUUID()
    const publicUrl = `/uploads/${file.filename}`
    const processingStatus = extractedText ? 'completed' : 'pending'

    await req.db
      .prepare(
        `
          INSERT INTO documents (
            id, organization_id, grant_id, profile_id, name, type,
            file_url, file_path, file_size, mime_type,
            extracted_text, processing_status, notes
          ) VALUES (?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        docId,
        name,
        KB_DOCUMENT_TYPE,
        publicUrl,
        file.path || null,
        file.size || null,
        file.mimetype || null,
        extractedText,
        processingStatus,
        notes,
      )

    // Trigger AI analysis if we have extracted text
    triggerKBAnalysis(req.db, docId, extractedText)

    // audit:allow unscoped-profile-query -- admin knowledge-base documents are global and stored with profile_id NULL.
    const doc = await req.db.prepare(`SELECT * FROM documents WHERE id = ? LIMIT 1`).get(docId)
    res.status(201).json({ ok: true, document: doc })
  } catch (error) {
    if (req.file?.path) safeDeleteFile(req, req.file.path)
    res.status(500).json({ ok: false, error: error?.message || String(error) })
  }
})

// POST /api/admin/knowledge/ingest-url
// Body: { url, name?, notes?, ocr?, handwriting?, ocr_language? }
router.post('/knowledge/ingest-url', async (req, res) => {
  if (!(await ensureAdminRequest(req, res))) return
  let downloaded = null
  try {
    const url = normalizeKnowledgeIngestUrl(req.body?.url)
    if (!url) return res.status(400).json({ ok: false, error: 'url is required' })

    downloaded = await downloadRemoteFileToUploads({ url, req })
    const file = downloaded.file

    const name =
      safeTrim(req.body?.name) ||
      safeTrim(downloaded.pageTitle) ||
      safeTrim(file.originalname) ||
      'Knowledge Document'
    const notes = safeTrim(req.body?.notes) || null

    let extractedText = null
    try {
      const ocr = req.body?.ocr === 'true' || req.body?.ocr === true
      const handwriting = req.body?.handwriting === 'true' || req.body?.handwriting === true
      const ocrLanguage = safeTrim(req.body?.ocr_language) || 'eng'
      const result = await extractTextFromFile({
        filePath: file.path,
        baseDir: getUploadsDir(req),
        mimeType: file.mimetype,
        fileName: file.originalname,
        ocr,
        handwriting,
        ocrLanguage,
      })
      extractedText = result?.text ?? null
    } catch {
      extractedText = null
    }

    const docId = crypto.randomUUID()
    const processingStatus = extractedText ? 'completed' : 'pending'

    await req.db
      .prepare(
        `
          INSERT INTO documents (
            id, organization_id, grant_id, profile_id, name, type,
            file_url, file_path, file_size, mime_type,
            extracted_text, processing_status, notes
          ) VALUES (?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        docId,
        name,
        KB_DOCUMENT_TYPE,
        downloaded.publicUrl,
        file.path || null,
        file.size || null,
        file.mimetype || null,
        extractedText,
        processingStatus,
        notes,
      )

    // Trigger AI analysis if we have extracted text
    triggerKBAnalysis(req.db, docId, extractedText)

    // audit:allow unscoped-profile-query -- admin knowledge-base documents are global and stored with profile_id NULL.
    const doc = await req.db.prepare(`SELECT * FROM documents WHERE id = ? LIMIT 1`).get(docId)
    res.status(201).json({ ok: true, document: doc })
  } catch (error) {
    if (downloaded?.file?.path) safeDeleteFile(req, downloaded.file.path)
    res.status(Number(error?.status) || 500).json({
      ok: false,
      error: error?.message || String(error),
      code: error?.code || undefined,
    })
  }
})

// DELETE /api/admin/knowledge/:id
router.delete('/knowledge/:id', async (req, res) => {
  if (!(await ensureAdminRequest(req, res))) return
  try {
    const id = safeTrim(req.params?.id)
    // audit:allow unscoped-profile-query -- admin knowledge-base documents are global and identified by type.
    const doc = await req.db
      .prepare(`SELECT id, file_path FROM documents WHERE id = ? AND type = ? LIMIT 1`)
      .get(id, KB_DOCUMENT_TYPE)
    if (!doc) return res.status(404).json({ ok: false, error: 'Not found' })

    // audit:allow unscoped-profile-query -- admin-only delete constrained by the type-checked row loaded above.
    await req.db.prepare(`DELETE FROM documents WHERE id = ?`).run(id)
    const deletedFile = doc.file_path ? safeDeleteFile(req, doc.file_path) : false

    res.json({ ok: true, deleted: true, deleted_file: deletedFile })
  } catch (error) {
    res.status(500).json({ ok: false, error: error?.message || String(error) })
  }
})

// POST /api/admin/knowledge/process-pending
// Trigger AI analysis for pending KB documents
router.post('/knowledge/process-pending', async (req, res) => {
  if (!(await ensureAdminRequest(req, res))) return
  try {
    const limit = parseInt(req.body?.limit || '10', 10)
    const result = await processPendingKBDocuments(req.db, limit)
    res.json({ ok: true, ...result })
  } catch (error) {
    res.status(500).json({ ok: false, error: error?.message || String(error) })
  }
})

// GET /api/admin/knowledge/opportunities
// Extract funding opportunities from analyzed KB documents
router.get('/knowledge/opportunities', async (req, res) => {
  if (!(await ensureAdminRequest(req, res))) return
  try {
    const opportunities = await extractFundingOpportunitiesFromKB(req.db)
    res.json({ ok: true, opportunities, count: opportunities.length })
  } catch (error) {
    res.status(500).json({ ok: false, error: error?.message || String(error) })
  }
})

// GET /api/admin/openai/runtime-secret-status
// Shows whether an encrypted runtime key is persisted in DB (never returns the key).
router.get('/openai/runtime-secret-status', async (req, res) => {
  if (!(await ensureAdminRequest(req, res))) return;

  try {
    const row = await req.db
      .prepare(
        `
          SELECT key, updated_at
          FROM app_runtime_secrets
          WHERE key = 'OPENAI_API_KEY'
          LIMIT 1
        `,
      )
      .get();

    res.json({
      ok: true,
      persisted: Boolean(row?.key),
      updated_at: row?.updated_at ?? null,
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error?.message || String(error) });
  }
});

// POST /api/admin/openai/persist-current
// Persists the currently active server-side OpenAI key (process.env.OPENAI_API_KEY) into DB (encrypted),
// so it can be restored on restart. Never returns the key.
router.post('/openai/persist-current', async (req, res) => {
  if (!(await ensureAdminRequest(req, res))) return;

  const apiKey = typeof process.env.OPENAI_API_KEY === 'string' ? process.env.OPENAI_API_KEY.trim() : ''
  if (!apiKey) {
    return res.status(400).json({
      ok: false,
      error: 'OPENAI_API_KEY is not set on this backend process',
    })
  }

  try {
    // Ensure it's valid before persisting.
    const { openai, diagnostics } = createOpenAIClient()
    await openai.models.list()

    const encrypted = encryptRuntimeSecret(apiKey)
    await req.db
      .prepare(
        `
          INSERT INTO app_runtime_secrets (key, value_ciphertext, iv, tag, updated_at)
          VALUES ('OPENAI_API_KEY', ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(key) DO UPDATE SET
            value_ciphertext = excluded.value_ciphertext,
            iv = excluded.iv,
            tag = excluded.tag,
            updated_at = CURRENT_TIMESTAMP
        `,
      )
      .run(encrypted.value_ciphertext, encrypted.iv, encrypted.tag)

    const status = await req.db
      .prepare(
        `
          SELECT updated_at
          FROM app_runtime_secrets
          WHERE key = 'OPENAI_API_KEY'
          LIMIT 1
        `,
      )
      .get()

    return res.json({
      ok: true,
      persisted: true,
      updated_at: status?.updated_at ?? null,
      diagnostics,
      note: 'Persisted to DB for emergency restart recovery. Set OPENAI_API_KEY in Railway for the real permanent fix.',
    })
  } catch (error) {
    const summary = summarizeOpenAIError(error)
    return res.status(summary.isAuth ? PROVIDER_AUTH_FAILURE_STATUS : 500).json({
      ok: false,
      error: summary.message,
      status: summary.status ?? null,
      hint: summary.isAuth
        ? 'Current OPENAI_API_KEY failed authentication; not persisting.'
        : 'Failed to persist current key. Check DB write access and try again.',
    })
  }
})

// AI prompt for extracting profile information from PDF text
const PROFILE_EXTRACTION_PROMPT = `You are an AI assistant that extracts organization profile information from documents. 
Analyze the provided text and extract the following information if available:

1. Organization/Entity name (required)
2. Organization type (nonprofit, for-profit, government, individual, etc.)
3. Contact information (email, phone, website)
4. Address (street, city, state, zip)
5. Mission or description
6. Tax ID or EIN (if nonprofit)
7. Key people (names and titles)
8. Financial information (annual budget, revenue, etc.)
9. Programs or services offered
10. Any other relevant organizational details

Return your response as a JSON object with the following structure:
{
  "display_name": "Organization Name",
  "primary_type": "nonprofit|for-profit|government|individual|other",
  "contact_info": {
    "email": "...",
    "phone": "...",
    "website": "..."
  },
  "address": {
    "street": "...",
    "city": "...",
    "state": "...",
    "zip": "..."
  },
  "mission": "...",
  "ein": "...",
  "key_people": [
    {"name": "...", "title": "..."}
  ],
  "financial_info": {
    "annual_budget": "...",
    "revenue": "..."
  },
  "programs": ["..."],
  "additional_details": "..."
}

Only include fields where you have found information. If a field is not found in the document, omit it from the JSON.
Be conservative - only include information you are confident about from the document text.`;

// POST /api/admin/upload-profile-document
// Upload a PDF document, extract text, use AI to parse it, and create a profile
router.post('/upload-profile-document', upload.single('document'), async (req, res) => {
  try {
    // Check admin access using centralized admin enforcement
    const adminCheck = req.ctx?.isAdmin === true;

    if (!adminCheck) {
      // Clean up uploaded file
      if (req.file) {
        try {
          fs.unlinkSync(req.file.path);
        } catch (err) {
          console.warn('Failed to remove uploaded file after auth failure', err);
        }
      }
      return res.status(403).json({ 
        error: 'Access denied',
        message: 'This endpoint is restricted to administrators only' 
      });
    }

    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'PDF document is required' });
    }

    try {
      // Step 1: Extract text from PDF
      const extractedText = await extractTextFromPDF(file.path);
      if (!extractedText) {
        return res.status(400).json({ 
          error: 'Unable to extract text from PDF',
          message: 'The PDF appears to be empty or contains only images' 
        });
      }

      // Step 2: Use OpenAI to extract structured profile information
      const { json: extractedDataJson, provider: aiProvider } = await invokeJsonWithFallback({
        system: PROFILE_EXTRACTION_PROMPT,
        prompt: `Extract profile information from this document:\n\n${extractedText.slice(0, MAX_TEXT_LENGTH_FOR_AI)}`,
        maxTokens: 1500,
        temperature: 0.1,
      })

      // If AI is unavailable/misconfigured, do NOT fail the admin workflow.
      // Create a profile from the filename + raw PDF text and queue deeper parsing when possible.
      const extractedData =
        extractedDataJson && typeof extractedDataJson === 'object'
          ? extractedDataJson
          : {
              display_name: file.originalname.replace(/\.[^/.]+$/, '').trim(),
              primary_type: null,
              _ai_provider: aiProvider,
              _ai_warning:
                'AI extraction unavailable (OpenAI key invalid/unconfigured and no Anthropic key present). Created profile with minimal fields.',
            }

      // Step 3: Create a new profile with extracted information
    const profileId = crypto.randomUUID();
    const displayName = extractedData.display_name || file.originalname.replace(/\.[^/.]+$/, '').trim() || 'New Organization';
    const primaryType = extractedData.primary_type || null;
    const status = 'active'; // Set as active since admin is creating it

    // Create profile in database
    await req.db.prepare(
      `INSERT INTO profiles (
        id,
        display_name,
        primary_type,
        status,
        tags,
        created_by
      ) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(profileId, displayName, primaryType, status, '[]', 'admin');

      // Step 4: Store the document and link it to the profile
    const documentId = crypto.randomUUID();
    const publicUrl = `/uploads/${file.filename}`;
    
    // IMPORTANT: Do NOT set documents.status on insert.
    // Rely on DB default and leave later status updates alone.
    const insertDocSql = `
      INSERT INTO documents (
        id,
        profile_id,
        name,
        type,
        file_url,
        file_path,
        file_size,
        mime_type,
        extracted_text,
        processing_status,
        notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    const insertDocArgs = [
      documentId,
      profileId,
      file.originalname,
      'profile_document',
      publicUrl,
      file.path,
      file.size,
      file.mimetype,
      extractedText,
      'completed',
      'Uploaded by admin for profile creation',
    ]
    try {
      await req.db.prepare(insertDocSql).run(...insertDocArgs)
    } catch (error) {
      const msg = String(error?.message || error)
      if (msg.includes('documents_status_check')) {
        await req.db.prepare(insertDocSql).run(...insertDocArgs)
      } else {
        throw error
      }
    }

    await req.db
      .prepare(
        `
          INSERT INTO profile_documents (profile_id, document_id)
          VALUES (?, ?)
          ON CONFLICT DO NOTHING
        `,
      )
      .run(profileId, documentId);

      // Step 5: Store extracted fields in profile_sections
      const sectionsToCreate = [];
      
      // Map extracted data to profile sections
      if (extractedData.contact_info || extractedData.address) {
        const basicInfo = {
          full_name: extractedData.display_name || '',
          email: extractedData.contact_info?.email || '',
          phone: extractedData.contact_info?.phone || '',
          website: extractedData.contact_info?.website || '',
          address: extractedData.address ? 
            `${extractedData.address.street || ''}, ${extractedData.address.city || ''}, ${extractedData.address.state || ''} ${extractedData.address.zip || ''}`.trim().replace(/^,\s*/, '') : '',
          notes: ''
        };
        sectionsToCreate.push({ key: 'basic_information', data: basicInfo });
      }
      
      if (extractedData.primary_type || extractedData.ein || extractedData.mission || extractedData.financial_info) {
        const orgDetails = {
          organization_type: extractedData.primary_type || '',
          ein: extractedData.ein || '',
          uei: '',
          cage_code: '',
          annual_budget: extractedData.financial_info?.annual_budget ? 
            parseInt(String(extractedData.financial_info.annual_budget).replace(/[^0-9]/g, '')) || null : null,
          staff_count: null,
          mission: extractedData.mission || ''
        };
        sectionsToCreate.push({ key: 'organization_details', data: orgDetails });
      }
      
      if (extractedData.programs && extractedData.programs.length > 0) {
        const narrative = {
          mission: extractedData.mission || '',
          primary_goal: '',
          target_population: '',
          funding_amount_needed: '',
          timeline: '',
          past_experience: extractedData.programs.join('; '),
          unique_qualities: '',
          collaboration_partners: '',
          sustainability_plan: '',
          barriers_faced: '',
          special_circumstances: extractedData.additional_details || ''
        };
        sectionsToCreate.push({ key: 'narrative', data: narrative });
      }

      // Insert all sections
      // audit:allow unscoped-profile-query -- INSERT includes profile_id and is scoped by values passed below.
      const insertSection = req.db.prepare(`
        INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(profile_id, section_key) DO UPDATE SET
          data = excluded.data,
          updated_at = CURRENT_TIMESTAMP,
          updated_by = excluded.updated_by
      `);
      
      for (const section of sectionsToCreate) {
        await insertSection.run(profileId, section.key, JSON.stringify(section.data), `document:${documentId}`);
      }

      // Step 6: Queue and dispatch document_ingest job for deeper AI parsing
      const parseJobId = crypto.randomUUID()
      await req.db
        .prepare(
          `
            INSERT INTO crawler_jobs (id, type, status, profile_id, organization_id, parameters, requested_by)
            VALUES (?, 'document_ingest', 'queued', ?, ?, ?, ?)
          `,
        )
        .run(parseJobId, profileId, null, JSON.stringify({ document_id: documentId, source: 'admin_upload' }), 'admin');
      
      // Get the job and dispatch it immediately
      const parseJob = await req.db.prepare('SELECT * FROM crawler_jobs WHERE id = ?').get(parseJobId);
      if (parseJob) {
        dispatchCrawlerJob({
          db: req.db,
          jobId: parseJob.id,
          uploadDir: getUploadsDir(req),
          getOpenAI: getOpenAIOptional,
        });
      }

      // Get the created profile
      const profile = await req.db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId);

      res.status(201).json({
        success: true,
        message: 'Profile created successfully from document',
        profile: {
          id: profile.id,
          display_name: profile.display_name,
          primary_type: profile.primary_type,
          status: profile.status,
          created_at: profile.created_at,
        },
        document_id: documentId,
        extracted_fields: extractedData,
        sections_created: sectionsToCreate.map(s => s.key),
        parsing_job_queued: true,
      });
    } finally {
      // Ensure file cleanup regardless of success or failure
      // File is kept only if successfully stored in DB, otherwise cleanup
      // Note: In this case, we keep the file since it's stored in uploads dir
      // and referenced in DB. Cleanup only on error paths.
    }
  } catch (error) {
    console.error('Admin document upload failed:', error);
    
    // Clean up uploaded file on error
    if (req.file) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (unlinkError) {
        console.warn('Failed to remove uploaded file after error', unlinkError);
      }
    }
    
    res.status(500).json({ 
      error: 'Failed to process document and create profile',
      error_type: 'admin_upload_failed',
      message:
        'The server failed to process the PDF. If this is an AI configuration issue, configure Anthropic as a fallback and retry.',
    });
  }
});

// Reattach users to profiles
router.post('/reattach-users', async (req, res) => {
  try {
    const db = req.db;

    const suppliedMappings = req.body?.mappings;
    if (!Array.isArray(suppliedMappings) || suppliedMappings.length === 0 || suppliedMappings.length > 50) {
      return res.status(400).json({
        error: 'mappings must be a non-empty array with at most 50 entries',
      });
    }

    const userMappings = [];
    for (const candidate of suppliedMappings) {
      const name = String(candidate?.name || '').trim();
      const emailPattern = String(candidate?.emailPattern || '').trim();
      const safeSelector = (value) => (
        value.length >= 2
        && value.length <= 100
        && !value.includes('%')
        && !value.includes('_')
        && /^[-a-z0-9@.+ ']+$/i.test(value)
      );
      if (!safeSelector(name) || !safeSelector(emailPattern)) {
        return res.status(400).json({
          error: 'each mapping requires safe name and emailPattern selectors (2-100 characters; no SQL wildcard characters)',
        });
      }
      userMappings.push({ name, emailPattern });
    }
    
    // Get admin user
    const adminUser = await db.prepare(`
      SELECT id, display_name, primary_email
      FROM users
      WHERE is_admin = TRUE
      LIMIT 1
    `).get();
    
    if (!adminUser) {
      return res.status(404).json({ error: 'Admin user not found' });
    }
    
    const results = {
      admin: adminUser,
      linked: [],
      errors: []
    };
    
    // Process each user
    for (const mapping of userMappings) {
      const user = await db.prepare(`
        SELECT id, display_name, primary_email
        FROM users
        WHERE LOWER(display_name) LIKE LOWER(?) OR LOWER(primary_email) LIKE LOWER(?)
        LIMIT 1
      `).get(`%${mapping.name}%`, `%${mapping.emailPattern}%`);
      
      if (!user) {
        results.errors.push(`User not found: ${mapping.name}`);
        continue;
      }
      
      const profiles = await db.prepare(`
        SELECT id, display_name
        FROM profiles
        WHERE LOWER(display_name) LIKE LOWER(?)
      `).all(`%${mapping.name}%`);
      
      if (profiles.length === 0) {
        results.errors.push(`No profiles found for: ${mapping.name}`);
        continue;
      }
      
      const updateStmt = db.prepare(`
        UPDATE profiles
        SET user_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `);
      
      for (const profile of profiles) {
        await updateStmt.run(user.id, profile.id);
        results.linked.push({
          user: user.display_name,
          profile: profile.display_name,
          profileId: profile.id
        });
      }
    }
    
    // Link admin to all unlinked profiles
    const linkAdminStmt = db.prepare(`
      UPDATE profiles
      SET user_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE user_id IS NULL
    `);
    const adminResult = await linkAdminStmt.run(adminUser.id);
    results.adminLinked = adminResult.changes;
    
    // Get final stats
    const stats = await db.prepare(`
      SELECT 
        COUNT(*) as total,
        COUNT(user_id) as linked
      FROM profiles
    `).get();
    results.stats = stats;
    
    res.json({
      success: true,
      message: `Reattached ${results.linked.length} profiles to users, ${results.adminLinked} to admin`,
      results
    });
  } catch (error) {
    console.error('[admin] Reattach users error:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/admin/diagnostics - System diagnostics (admin only)
router.get('/diagnostics', async (req, res) => {
  try {
    if (!(await ensureAdminRequest(req, res))) return;

    const diagnostics = await getSystemDiagnostics(req.db);
    res.json(diagnostics);
  } catch (error) {
    console.error('[admin/diagnostics] Error:', error);
    res.status(500).json({ 
      error: 'Failed to get diagnostics',
      message: error.message || 'An unexpected error occurred'
    });
  }
});

function loginEventTimeMs(event) {
  const ms = Date.parse(String(event?.at || ''))
  return Number.isFinite(ms) ? ms : 0
}

function normalizeLoginEvents(events, limit) {
  const byId = new Map()
  for (const event of Array.isArray(events) ? events : []) {
    if (!event) continue
    const id = event.id ? String(event.id) : `event:${loginEventTimeMs(event)}:${event.identifier || ''}:${event.method || ''}`
    if (!byId.has(id)) byId.set(id, { ...event, id })
  }
  return Array.from(byId.values())
    .sort((a, b) => loginEventTimeMs(b) - loginEventTimeMs(a))
    .slice(0, limit)
}

// GET /api/admin/login-events - Recent client logins (admin only)
// Preferred: DB-backed audit logs + session backfill. Falls back to in-memory ring buffer.
router.get('/login-events', async (req, res, next) => {
  try {
    if (!(await ensureAdminRequest(req, res))) return

    // Polled by the Admin UI; prevent conditional GETs (304) which break JSON parsing.
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
    res.set('Pragma', 'no-cache')

    const since = typeof req.query?.since === 'string' ? req.query.since : null
    const limitRaw = typeof req.query?.limit === 'string' ? req.query.limit : null
    const limit = Math.max(1, Math.min(100, limitRaw ? Number(limitRaw) : 25))

    const sinceMs = since ? Date.parse(String(since)) : NaN
    const startDateIso = Number.isFinite(sinceMs) ? new Date(sinceMs).toISOString() : null

    // 1) Durable source: audit_logs (client_sign_in)
    const events = []
    // Session ids already represented by a client_sign_in audit row. A fresh
    // login writes BOTH a user_sessions row and an audit row in the same
    // createSessionAndTokens call (tagged with the session id), so without
    // this set the merge below would render one login as two events. The
    // audit row carries the real method (password/email/oauth/…); the session
    // row only ever carried a synthetic 'session' label, so dropping the
    // duplicate loses nothing.
    const auditedSessionIds = new Set()
    const sourceStatus = {
      audit_logs: { ok: true },
      user_sessions: { ok: true },
      memory_fallback: { used: false },
    }
    try {
      await req.db
        .prepare('SELECT id, created_at, action, details, user_id, profile_id, ip_address, user_agent FROM audit_logs LIMIT 1')
        .get()
      const auditRes = await queryAuditLogs(req.db, {
        action: 'client_sign_in',
        startDate: startDateIso,
        limit: Math.max(1, Math.min(200, limit)),
        offset: 0,
      })

      for (const row of auditRes?.logs || []) {
        const details = row?.details && typeof row.details === 'object' ? row.details : {}
        const auditSessionId = details?.session_id ?? row?.resource_id ?? null
        if (auditSessionId) auditedSessionIds.add(String(auditSessionId))
        events.push({
          id: row.id,
          type: 'client_sign_in',
          at: row.created_at,
          identifier: details?.identifier ?? null,
          method: details?.method ?? null,
          session_id: auditSessionId,
          user_id: row.user_id ?? null,
          profile_id: row.profile_id ?? null,
          ip: row.ip_address ?? null,
          user_agent: row.user_agent ?? null,
        })
      }
    } catch (auditErr) {
      sourceStatus.audit_logs = { ok: false, error: auditErr?.message || String(auditErr) }
      console.warn('[admin/login-events] audit_logs query failed:', auditErr?.message || auditErr)
    }

    // 2) Backfill: sessions table (helps recover events from before audit logging existed)
    // Query independently from audit_logs, then merge/sort below. The old
    // "only if audit rows are under the limit" behavior could hide newer
    // session rows behind older durable audit rows.
    try {
      const sessionLimit = Math.max(1, Math.min(200, limit))
      const rows = startDateIso
        ? await req.db
            .prepare(
              `
                SELECT
                  s.id,
                  COALESCE(s.issued_at, s.created_at) AS at,
                  s.user_id,
                  s.profile_id,
                  s.ip_address,
                  s.user_agent,
                  u.primary_email,
                  u.is_admin
                FROM user_sessions s
                LEFT JOIN users u ON u.id = s.user_id
                WHERE COALESCE(s.issued_at, s.created_at) > ?
                ORDER BY COALESCE(s.issued_at, s.created_at) DESC
                LIMIT ?
              `,
            )
            .all(startDateIso, sessionLimit)
        : await req.db
            .prepare(
              `
                SELECT
                  s.id,
                  COALESCE(s.issued_at, s.created_at) AS at,
                  s.user_id,
                  s.profile_id,
                  s.ip_address,
                  s.user_agent,
                  u.primary_email,
                  u.is_admin
                FROM user_sessions s
                LEFT JOIN users u ON u.id = s.user_id
                ORDER BY COALESCE(s.issued_at, s.created_at) DESC
                LIMIT ?
              `,
            )
            .all(sessionLimit)

      for (const r of rows || []) {
        // Skip sessions already represented by a client_sign_in audit row (see
        // above): they are the SAME login, and the audit row carries the real
        // method while this session row only carries the synthetic 'session'
        // label. Pre-audit rows (historical, before the link existed) are never
        // in the set, so historical backfill still surfaces them.
        if (r?.id && auditedSessionIds.has(String(r.id))) continue
        events.push({
          id: `session:${r.id}`,
          type: 'client_sign_in',
          at: r.at,
          identifier: r.primary_email ?? null,
          method: 'session',
          user_id: r.user_id ?? null,
          profile_id: r.profile_id ?? null,
          ip: r.ip_address ?? null,
          user_agent: r.user_agent ?? null,
        })
      }
    } catch (sessionErr) {
      sourceStatus.user_sessions = { ok: false, error: sessionErr?.message || String(sessionErr) }
      console.warn('[admin/login-events] session backfill failed:', sessionErr?.message || sessionErr)
    }

    const durableFailed = !sourceStatus.audit_logs.ok && !sourceStatus.user_sessions.ok
    if (durableFailed) {
      return res.status(503).json({
        ok: false,
        error: 'login_events_unavailable',
        message: 'GrantFlow could not read durable login audit/session sources.',
        source_status: sourceStatus,
      })
    }

    // 3) Final fallback: in-memory ring buffer (dev only / best-effort)
    const fallbackEvents = events.length > 0 ? [] : listClientSignInEvents({ since, limit })
    sourceStatus.memory_fallback.used = events.length === 0 && fallbackEvents.length > 0
    const finalEvents = normalizeLoginEvents(
      events.length > 0 ? events : fallbackEvents,
      limit,
    )

    return res.json({
      ok: true,
      degraded: !sourceStatus.audit_logs.ok || !sourceStatus.user_sessions.ok || sourceStatus.memory_fallback.used,
      source_status: sourceStatus,
      events: finalEvents,
    })
  } catch (error) {
    routeLogger.error('[admin/login-events] Error:', error)
    return next(error)
  }
})

// GET /api/admin/page-views - Recent client page views (admin only)
// Durable source: audit_logs (client_page_view).
router.get('/page-views', async (req, res, next) => {
  try {
    if (!(await ensureAdminRequest(req, res))) return

    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
    res.set('Pragma', 'no-cache')

    const since = typeof req.query?.since === 'string' ? req.query.since : null
    const limitRaw = typeof req.query?.limit === 'string' ? req.query.limit : null
    const limit = Math.max(1, Math.min(200, limitRaw ? Number(limitRaw) : 50))

    const sinceMs = since ? Date.parse(String(since)) : NaN
    const startDateIso = Number.isFinite(sinceMs) ? new Date(sinceMs).toISOString() : null

    const views = []

    // Match on the unique `action` discriminator only — NOT category. The writer
    // (POST /api/activity/page-view) records these under category 'user_activity',
    // so filtering by a fixed category here silently dropped every row. The action
    // 'client_page_view' is unique to page views, so it is a safe, drift-proof key
    // that also surfaces any historical rows written under a different category.
    const auditRes = await queryAuditLogs(req.db, {
      action: 'client_page_view',
      startDate: startDateIso,
      limit,
      offset: 0,
    })

    // Resolve user emails in one query (best-effort).
    const userIds = Array.from(
      new Set((auditRes?.logs || []).map((r) => r?.user_id).filter(Boolean).map((v) => String(v))),
    )
    const usersById = new Map()
    if (userIds.length > 0) {
      const placeholders = userIds.map(() => '?').join(', ')
      try {
        const rows = await req.db
          .prepare(
            `
              SELECT id, primary_email, display_name, is_admin
              FROM users
              WHERE id IN (${placeholders})
            `,
          )
          .all(...userIds)
        for (const u of rows || []) {
          if (u?.id) usersById.set(String(u.id), u)
        }
      } catch {
        // ignore user lookup failures
      }
    }

    for (const row of auditRes?.logs || []) {
      const details = row?.details && typeof row.details === 'object' ? row.details : {}
      const userId = row?.user_id ? String(row.user_id) : null
      const user = userId ? usersById.get(userId) : null
      views.push({
        id: row.id,
        at: row.created_at,
        user_id: userId,
        user_email: user?.primary_email ?? null,
        user_name: user?.display_name ?? null,
        is_admin: user?.is_admin ?? null,
        profile_id: row.profile_id ?? null,
        path: details?.path ?? null,
        title: details?.title ?? null,
        referrer: details?.referrer ?? null,
        ip: row.ip_address ?? null,
      })
    }

    return res.json({ ok: true, page_views: views })
  } catch (error) {
    routeLogger.error('[admin/page-views] Error:', error)
    return next(error)
  }
})

// Lookup recent server-side error details by Request ID (admin-only).
// This is stored in-memory (best-effort) to help non-technical admins debug production issues.
router.get('/errors/:requestId', async (req, res) => {
  try {
    if (!(await ensureAdminRequest(req, res))) return
    const requestId = String(req.params.requestId || '').trim()
    if (!requestId) return res.status(400).json({ error: 'requestId is required' })
    const entry = getRequestError(requestId)
    if (!entry) return res.status(404).json({ error: 'Request ID not found (may have expired)' })
    return res.json({ ok: true, ...entry })
  } catch (error) {
    return res.status(500).json({ error: error?.message || String(error) })
  }
})

/**
 * Geo Crawl support endpoints (admin-only)
 * These power the Geo Crawl UI state dropdown and scoping selectors.
 */
router.get('/geo/states', async (req, res) => {
  try {
    if (!(await ensureAdminRequest(req, res))) return;
    const index = buildZipStateIndex();

    // Prefer dataset-driven states if present; otherwise fall back to a canonical US state list.
    const stateKeys = index.size > 0 ? Array.from(index.keys()) : Array.from(US_STATE_CODES)
    stateKeys.sort()

    const states = stateKeys.map((state) => ({
      state,
      zip_count: index.get(state)?.length ?? 0,
    }))

    res.json({
      states,
      dataset_present: index.size > 0,
      dataset_source: zipCoordinatesMissing ? 'zipcodes' : 'zip_coordinates.json',
    })
  } catch (error) {
    console.error('[admin/geo/states] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/geo/state/:state/zips', async (req, res) => {
  try {
    if (!(await ensureAdminRequest(req, res))) return;
    const state = String(req.params.state || '').toUpperCase();
    const index = buildZipStateIndex();
    res.json({
      zips: index.get(state) ?? [],
      dataset_present: index.size > 0,
      dataset_source: zipCoordinatesMissing ? 'zipcodes' : 'zip_coordinates.json',
    });
  } catch (error) {
    console.error('[admin/geo/state/zips] Error:', error);
    res.status(500).json({ error: error.message });
  }
});


async function computeCountiesForState(stateCode) {
  const state = String(stateCode || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(state)) return [];

  // Use the same ZIP index we expose to the admin UI (ensures city/state normalization matches).
  const idx = buildZipStateIndex();
  const rows = idx.get(state) || [];
  if (!rows.length) return [];

  const normalize = (v) =>
    String(v || '')
      .trim()
      .toLowerCase()
      .replace(/\s+county\s*$/, '');

  const seen = new Map(); // normalized -> original (first seen)
  for (const row of rows) {
    const zip = String(row?.zip_code || '').padStart(5, '0');
    if (!/^\d{5}$/.test(zip)) continue;

    const county = await resolveCountyForZip(zip, state);
    if (!county) continue;

    const norm = normalize(county);
    if (!norm) continue;
    if (!seen.has(norm)) seen.set(norm, String(county).trim());
  }

  return Array.from(seen.values()).sort((a, b) => a.localeCompare(b));
}

router.get('/geo/state/:state/counties', async (req, res) => {
  try {
    if (!(await ensureAdminRequest(req, res))) return;
    const state = String(req.params.state || '').toUpperCase();
    const countiesByState = loadCountiesByState();
    let list = Array.isArray(countiesByState?.[state]) ? countiesByState[state] : [];

    let source =
      process.env.GEO_COUNTIES_BY_STATE_PATH && fs.existsSync(resolve(process.env.GEO_COUNTIES_BY_STATE_PATH))
        ? 'GEO_COUNTIES_BY_STATE_PATH'
        : fs.existsSync(countiesByStatePath)
          ? 'fallback_file'
          : 'missing';

    // If we don't have a file-backed counties index, compute it from the ZIP->county resolver.
    if (!list.length) {
      list = await computeCountiesForState(state);
      if (list.length) {
        countiesByState[state] = list;
        source = 'computed_from_zip_index';
      }
    }

    res.json({
      counties: list.map((county) => ({ county })),
      available: list.length > 0,
      source,
    });
  } catch (error) {
    console.error('[admin/geo/state/counties] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/geo/state/:state/index-counties', async (req, res) => {
  try {
    if (!(await ensureAdminRequest(req, res))) return;
    const state = String(req.params.state || '').toUpperCase();

    const countiesByState = loadCountiesByState();
    let list = Array.isArray(countiesByState?.[state]) ? countiesByState[state] : [];

    // If file-backed dataset is missing/empty, fall back to Census API and cache the result.
    let source = fs.existsSync(countiesByStatePath) ? 'fallback_file' : 'missing'
    if (process.env.GEO_COUNTIES_BY_STATE_PATH && fs.existsSync(resolve(process.env.GEO_COUNTIES_BY_STATE_PATH))) {
      source = 'GEO_COUNTIES_BY_STATE_PATH'
    }

    if (!list.length) {
      const computed = await computeCountiesForState(state);
      if (computed.length) {
        countiesByState[state] = computed;
        list = computed;
        source = 'computed_from_zip_index';
      }
    }

    // This endpoint is synchronous (load/validate). Return a completed “job” placeholder for UI consistency.
    const job = { id: crypto.randomUUID(), status: 'completed' };
    res.json({
      ok: true,
      success: true,
      job,
      state,
      counties: list.length,
      available: list.length > 0,
      source,
      warning:
        list.length > 0
          ? null
          : 'No counties could be resolved for this state from the ZIP index. (This usually means the ZIP dataset is missing or the county resolver is unavailable.)',
    });
  } catch (error) {
    console.error('[admin/geo/state/index-counties] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/geo/crawl/status', async (req, res) => {
  try {
    if (!(await ensureAdminRequest(req, res))) return;
    // This endpoint is polled by the Admin UI; prevent conditional GETs (304) which break JSON parsing.
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.set('Surrogate-Control', 'no-store');
    const latest = await req.db
      .prepare(
        `
          SELECT id, type, status, created_at, started_at, completed_at, result_count, error, result_meta, parameters
          FROM crawler_jobs
          WHERE type = 'comprehensive'
            AND parameters LIKE '%"mode":"geo"%'
          ORDER BY created_at DESC
          LIMIT 1
        `,
      )
      .get();
    const job = latest ?? null
    if (!job) return res.json({ geo_crawl: null })

    let resultMeta = null
    try {
      resultMeta = job.result_meta ? JSON.parse(job.result_meta) : null
    } catch {
      resultMeta = null
    }

    let params = null
    try {
      params = job.parameters ? JSON.parse(job.parameters) : null
    } catch {
      params = null
    }

    // Normalize shape for the AdminGeoCrawl UI.
    res.json({
      geo_crawl: {
        id: job.id,
        type: job.type,
        status: job.status,
        created_at: job.created_at,
        started_at: job.started_at,
        completed_at: job.completed_at,
        error: job.error ?? null,
        result_count: job.result_count ?? null,
        // Friendly progress fields (best-effort)
        processed: resultMeta?.processed ?? null,
        total_zips: resultMeta?.total_zips ?? params?.max_zips ?? params?.maxZips ?? null,
        inserted: resultMeta?.sources ?? job.result_count ?? null,
        // Some deployments also track "linked" in result_meta; keep this field for UI stability.
        linked: resultMeta?.linked ?? null,
        failed: resultMeta?.failed ?? null,
        skipped: resultMeta?.skipped ?? null,
      },
    })
  } catch (error) {
    console.error('[admin/geo/crawl/status] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Summary: counts per state + last geo run (admin-only)
router.get('/geo/summary', async (req, res) => {
  try {
    if (!(await ensureAdminRequest(req, res))) return;

    // Counts per state from funding_opportunities
    const counts = await req.db
      .prepare(
        `
          SELECT state, COUNT(*) as count
          FROM funding_opportunities
          WHERE state IS NOT NULL
            AND length(state) = 2
          GROUP BY state
          ORDER BY state ASC
        `,
      )
      .all()

    const countMap = new Map((counts || []).map((r) => [String(r.state || '').toUpperCase(), Number(r.count || 0)]))

    // Last run per state (dialect-specific best-effort)
    const lastRuns =
      req.db?.dialect === 'postgres'
        ? await req.db
            .prepare(
              `
                SELECT DISTINCT ON (state)
                  state,
                  status,
                  started_at,
                  completed_at,
                  processed_zips,
                  sources_inserted,
                  failed_zips,
                  skipped_zips,
                  error
                FROM geo_state_runs
                ORDER BY state, started_at DESC
              `,
            )
            .all()
        : await req.db
            .prepare(
              `
                SELECT r.*
                FROM geo_state_runs r
                JOIN (
                  SELECT state, MAX(started_at) AS started_at
                  FROM geo_state_runs
                  GROUP BY state
                ) latest
                ON latest.state = r.state AND latest.started_at = r.started_at
                ORDER BY r.state ASC
              `,
            )
            .all()

    const lastRunMap = new Map(
      (lastRuns || []).map((r) => [
        String(r.state || '').toUpperCase(),
        {
          status: r.status ?? null,
          started_at: r.started_at ?? null,
          completed_at: r.completed_at ?? null,
          processed_zips: Number(r.processed_zips || 0),
          sources_inserted: Number(r.sources_inserted || 0),
          failed_zips: Number(r.failed_zips || 0),
          skipped_zips: Number(r.skipped_zips || 0),
          error: r.error ?? null,
        },
      ]),
    )

    const stateKeys = Array.from(US_STATE_CODES).slice().sort()
    const summary = stateKeys.map((st) => ({
      state: st,
      opportunity_count: countMap.get(st) ?? 0,
      last_run: lastRunMap.get(st) ?? null,
    }))

    res.json({ states: summary })
  } catch (error) {
    routeLogger.error('[admin/geo/summary] Error:', error)
    res.status(500).json({ error: error?.message || String(error) })
  }
})

// ZIP-level geo coverage report (admin-only).
//
// Answers: "Has the geocrawl run via every US ZIP code?" by comparing the
// `zipcodes` package (~43k US ZIPs — the same source nationalZipCrawler.js
// uses to build US_ZIP_CODES_ALL) against the `national_zip_progress` table.
//
// Returns:
//   {
//     total_us_zips,           // total ZIPs in the zipcodes dataset
//     progress_total,          // total rows in national_zip_progress
//     progress_completed,      // rows with status='completed'
//     progress_in_progress,
//     progress_failed,
//     progress_skipped,
//     progress_pending,
//     coverage_percent,        // (completed / total_us_zips) * 100
//     uncovered_zip_count,     // total_us_zips - completed
//     by_state: [
//       { state, total_zips, completed, pending, percent }
//     ]
//   }
// The 51 jurisdictions the comprehensive ZIP crawler actually walks (50 states + DC).
// MUST stay in sync with backend/services/comprehensiveCrawlerOptimized.js's
// statesToRun default list. Anything not in this set is excluded from the
// "real US coverage" math (territories, military APO/FPO, and bogus Canadian
// province strings that leak in from the zipcodes NPM dataset).
const CRAWLABLE_US_JURISDICTIONS = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA',
  'HI','ID','IL','IN','IA','KS','KY','LA','ME','MD',
  'MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC',
  'SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC',
])

router.get('/geo/zip-coverage', async (req, res) => {
  try {
    if (!(await ensureAdminRequest(req, res))) return

    res.set('Cache-Control', 'no-store')

    // 1. Build the canonical ZIP universe + per-state ZIP counts from the
    //    zipcodes dataset (same source nationalZipCrawler.js uses).
    //
    //    The dataset is noisy: it includes ~2,500 entries that are NOT US
    //    state ZIPs the crawler will ever walk — Canadian postal codes
    //    (Ontario, Quebec, …), military APO/FPO buckets (AA, AE, AP), and
    //    US territories (PR, GU, VI, AS, MP, FM, MH, PW). We partition the
    //    universe into "crawlable US" vs "non-crawlable" so the coverage
    //    percentage reflects what the system can actually reach, instead
    //    of being permanently capped at ~94% by data noise.
    const allZipObj = (zipcodes?.codes && typeof zipcodes.codes === 'object') ? zipcodes.codes : {}
    const allZips = Object.keys(allZipObj)
    const totalDatasetZips = allZips.length

    const stateZipCounts = new Map() // state -> count (for ALL dataset entries)
    const crawlableZipSet = new Set() // every zip in a crawlable US jurisdiction
    for (const zip of allZips) {
      const meta = allZipObj[zip]
      const st = String(meta?.state || '').toUpperCase()
      if (!st) continue
      stateZipCounts.set(st, (stateZipCounts.get(st) || 0) + 1)
      if (CRAWLABLE_US_JURISDICTIONS.has(st)) {
        crawlableZipSet.add(String(zip).padStart(5, '0'))
      }
    }
    const crawlableUsZips = crawlableZipSet.size

    // 2. Pull per-status counts from national_zip_progress.
    let statusCounts = []
    try {
      statusCounts = await req.db
        .prepare('SELECT status, COUNT(*) as count FROM national_zip_progress GROUP BY status')
        .all()
    } catch (e) {
      statusCounts = []
    }
    const statusMap = new Map((statusCounts || []).map((r) => [String(r.status || ''), Number(r.count || 0)]))
    const progressTotal = (statusCounts || []).reduce((s, r) => s + Number(r.count || 0), 0)
    const completedCount = statusMap.get('completed') ?? 0
    const inProgressCount = statusMap.get('in_progress') ?? 0
    const failedCount = statusMap.get('failed') ?? 0
    const skippedCount = statusMap.get('skipped') ?? 0
    const pendingCount = statusMap.get('pending') ?? 0

    // 3. Per-state breakdown: how many of each state's ZIPs are completed.
    //    We resolve each progress row's state by looking it up in the zipcodes
    //    dataset (the table itself doesn't store state, only the zip).
    let progressRows = []
    try {
      progressRows = await req.db
        .prepare(`SELECT zip, status FROM national_zip_progress`)
        .all()
    } catch (e) {
      progressRows = []
    }

    const perState = new Map() // state -> { completed, in_progress, failed, skipped, pending, other }
    let crawlableCompleted = 0
    function bumpState(st, key) {
      if (!st) return
      if (!perState.has(st)) {
        perState.set(st, { completed: 0, in_progress: 0, failed: 0, skipped: 0, pending: 0, other: 0 })
      }
      const slot = perState.get(st)
      if (key in slot) slot[key] += 1
      else slot.other += 1
    }
    for (const row of progressRows) {
      const zip = String(row.zip || '').padStart(5, '0')
      const meta = allZipObj[zip]
      const st = String(meta?.state || '').toUpperCase()
      const status = String(row.status || '')
      bumpState(st, status)
      if (status === 'completed' && CRAWLABLE_US_JURISDICTIONS.has(st) && crawlableZipSet.has(zip)) {
        crawlableCompleted += 1
      }
    }

    const byState = Array.from(stateZipCounts.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([st, totalZips]) => {
        const slot = perState.get(st) || { completed: 0, in_progress: 0, failed: 0, skipped: 0, pending: 0, other: 0 }
        const completed = slot.completed
        const percent = totalZips > 0 ? Math.round((completed / totalZips) * 1000) / 10 : 0
        return {
          state: st,
          total_zips: totalZips,
          completed,
          in_progress: slot.in_progress,
          failed: slot.failed,
          skipped: slot.skipped,
          pending: slot.pending,
          percent,
          crawlable: CRAWLABLE_US_JURISDICTIONS.has(st),
        }
      })

    // The headline "coverage" we report is over the CRAWLABLE universe (50
    // states + DC). We keep `dataset_*` fields for callers that want the
    // raw zipcodes-package totals (legacy + diagnostics).
    const crawlableCoveragePercent =
      crawlableUsZips > 0 ? Math.round((crawlableCompleted / crawlableUsZips) * 1000) / 10 : 0

    res.json({
      ok: true,

      // Headline numbers (what the system can actually reach):
      crawlable_us_zips: crawlableUsZips,
      crawlable_completed: crawlableCompleted,
      coverage_percent: crawlableCoveragePercent,
      uncovered_zip_count: Math.max(0, crawlableUsZips - crawlableCompleted),

      // Status breakdown across ALL rows in national_zip_progress
      // (includes any past one-off territory/military crawls).
      progress_total: progressTotal,
      progress_completed: completedCount,
      progress_in_progress: inProgressCount,
      progress_failed: failedCount,
      progress_skipped: skippedCount,
      progress_pending: pendingCount,

      // Raw zipcodes-package totals, for diagnostics. These include ~2.5k
      // non-crawlable entries (territories, military, Canadian noise).
      total_us_zips: crawlableUsZips, // alias preserved for back-compat (was the noisy total)
      dataset_total_zips: totalDatasetZips,
      dataset_coverage_percent:
        totalDatasetZips > 0 ? Math.round((completedCount / totalDatasetZips) * 1000) / 10 : 0,
      dataset_uncovered_count: Math.max(0, totalDatasetZips - completedCount),

      by_state: byState,
    })
  } catch (error) {
    routeLogger.error('[admin/geo/zip-coverage] Error:', error)
    res.status(500).json({ error: error?.message || String(error) })
  }
})

router.post('/geo/crawl/start', async (req, res) => {
  try {
    if (!(await ensureAdminRequest(req, res))) return;
    // The legacy `comprehensive` dispatcher job is intentionally retired by
    // the Crawler OS cutover. Creating it here used to return 201 and then mark
    // the job `superseded_by_crawler_os`, a false "started" experience. Keep
    // historical status/coverage endpoints available, but refuse new global
    // ZIP mutations until a native, profile-scoped Crawler OS replacement is
    // reviewed and tested.
    return res.status(410).json({
      ok: false,
      error: 'geo_crawl_start_retired',
      code: 'GEO_CRAWL_START_RETIRED',
      message: 'Legacy global ZIP crawl start is retired. Run current Crawler OS discovery from a consented profile instead.',
      replacement: 'profile_scoped_crawler_os',
    })
  } catch (error) {
    console.error('[admin/geo/crawl/start] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/admin/db-stats - Database statistics
router.get('/db-stats', async (req, res) => {
  try {
    const stats = {
      profiles: 0,
      profile_sections: 0,
      funding_opportunities: 0,
      grants: 0,
      organizations: 0,
    };

    // NOTE: keep this endpoint sync-safe by using awaits (works for both sqlite + postgres wrapper).
    stats.profiles = Number((await req.db.prepare('SELECT COUNT(*) as count FROM profiles').get())?.count || 0);
    stats.profile_sections = Number((await req.db.prepare('SELECT COUNT(*) as count FROM profile_sections').get())?.count || 0);
    stats.funding_opportunities = Number((await req.db.prepare('SELECT COUNT(*) as count FROM funding_opportunities').get())?.count || 0);
    stats.grants = Number((await req.db.prepare('SELECT COUNT(*) as count FROM grants').get())?.count || 0);
    stats.organizations = Number((await req.db.prepare('SELECT COUNT(*) as count FROM organizations').get())?.count || 0);

    const sampleOpps = await req.db.prepare(`
      SELECT title, keywords, categories 
      FROM funding_opportunities 
      WHERE is_active = ? 
      LIMIT 5
    `).all(true);

    res.json({ success: true, stats, sample_opportunities: sampleOpps });
  } catch (error) {
    console.error('[admin/db-stats] Error:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to get database stats' });
  }
});

/**
 * GET /api/admin/profiles/search?q=melissa&limit=50
 *
 * Admin-only: find profiles by display_name or id substring (locate duplicates / legacy UUID rows).
 */
router.get('/profiles/search', async (req, res) => {
  if (!(await ensureAdminRequest(req, res))) return

  const q = String(req.query?.q || '').trim()
  if (q.length < 2) {
    return res.status(400).json({ ok: false, error: 'Query q must be at least 2 characters' })
  }
  const lim = Math.max(1, Math.min(Number(req.query?.limit) || 50, 200))
  const esc = q.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
  const like = `%${esc}%`

  try {
    let rows
    if (req.db?.dialect === 'postgres') {
      rows = await req.db
        .prepare(
          `
            SELECT id, display_name, user_id, created_by, status, primary_type, updated_at
            FROM profiles
            WHERE (display_name ILIKE $1 ESCAPE '\\' OR id ILIKE $1 ESCAPE '\\')
              AND (status IS NULL OR lower(status) <> 'deleted')
            ORDER BY updated_at DESC NULLS LAST
            LIMIT $2
          `,
        )
        .all(like, lim)
    } else {
      rows = await req.db
        .prepare(
          `
            SELECT id, display_name, user_id, created_by, status, primary_type, updated_at
            FROM profiles
            WHERE (display_name LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\')
              AND (status IS NULL OR lower(status) <> 'deleted')
            ORDER BY updated_at DESC
            LIMIT ?
          `,
        )
        .all(like, like, lim)
    }

    res.json({ ok: true, q, limit: lim, count: rows?.length ?? 0, profiles: rows || [] })
  } catch (error) {
    routeLogger.error('[admin/profiles/search]', error)
    res.status(500).json({ ok: false, error: error?.message || String(error) })
  }
})

/**
 * GET /api/admin/profiles/integrity
 *
 * Admin-only: consolidated profile integrity report.
 *
 * Goals:
 * - profiles never “disappear” silently
 * - detect orphaned / unowned / dangling-link profiles
 * - surface likely duplicates (email/phone keyed) without mutating data
 *
 * Query:
 * - limitOwners: number (default 25)
 * - limitOrphans: number (default 200)
 * - limitDuplicateGroups: number (default 25)
 * - includeInactive: boolean (default true) for duplicate detection
 */
router.get('/profiles/integrity', async (req, res) => {
  if (!(await ensureAdminRequest(req, res))) return

  const limitOwners = Math.max(1, Math.min(Number(req.query?.limitOwners) || 25, 200))
  const limitOrphans = Math.max(1, Math.min(Number(req.query?.limitOrphans) || 200, 2000))
  const limitDuplicateGroups = Math.max(1, Math.min(Number(req.query?.limitDuplicateGroups) || 25, 200))
  const includeInactive = String(req.query?.includeInactive ?? 'true').toLowerCase() === 'true'

  const generatedAt = new Date().toISOString()
  const warnings = []
  const errors = []

  const safeCount = async (sql, params = []) => {
    try {
      const row = await req.db.prepare(sql).get(...params)
      return Number(row?.count || 0)
    } catch (e) {
      errors.push({ type: 'query_failed', sql, message: e?.message || String(e) })
      return null
    }
  }

  const safeAll = async (sql, params = []) => {
    try {
      return await req.db.prepare(sql).all(...params)
    } catch (e) {
      errors.push({ type: 'query_failed', sql, message: e?.message || String(e) })
      return null
    }
  }

  const totalProfiles = await safeCount('SELECT COUNT(*) as count FROM profiles')
  const totalOrganizations = await safeCount('SELECT COUNT(*) as count FROM organizations')
  const totalUsers = await safeCount('SELECT COUNT(*) as count FROM users')

  const byStatusRows = await safeAll(
    `
      SELECT
        COALESCE(NULLIF(TRIM(status), ''), '(unset)') AS status,
        COUNT(*) as count
      FROM profiles
      GROUP BY COALESCE(NULLIF(TRIM(status), ''), '(unset)')
      ORDER BY count DESC
    `,
  )

  const byPrimaryTypeRows = await safeAll(
    `
      SELECT
        COALESCE(NULLIF(TRIM(primary_type), ''), '(unset)') AS primary_type,
        COUNT(*) as count
      FROM profiles
      GROUP BY COALESCE(NULLIF(TRIM(primary_type), ''), '(unset)')
      ORDER BY count DESC
    `,
  )

  const unownedProfiles = await safeCount(
    `
      SELECT COUNT(*) as count
      FROM profiles
      WHERE user_id IS NULL OR TRIM(user_id) = ''
    `,
  )

  const missingUserLinks = await safeCount(
    `
      SELECT COUNT(*) as count
      FROM profiles p
      LEFT JOIN users u ON u.id = p.user_id
      WHERE p.user_id IS NOT NULL AND TRIM(p.user_id) <> ''
        AND u.id IS NULL
    `,
  )

  const missingOrgLinks = await safeCount(
    `
      SELECT COUNT(*) as count
      FROM profiles p
      LEFT JOIN organizations o ON o.id = p.organization_id
      WHERE p.organization_id IS NOT NULL AND TRIM(p.organization_id) <> ''
        AND o.id IS NULL
    `,
  )

  // Owners (top N)
  const owners = await safeAll(
    `
      SELECT
        p.user_id,
        COUNT(*) as count,
        u.primary_email as user_email,
        u.display_name as user_name,
        MAX(p.updated_at) as last_profile_updated_at
      FROM profiles p
      LEFT JOIN users u ON u.id = p.user_id
      WHERE p.user_id IS NOT NULL AND TRIM(p.user_id) <> ''
      GROUP BY p.user_id, u.primary_email, u.display_name
      ORDER BY count DESC
      LIMIT ?
    `,
    [limitOwners],
  )

  // Orphan candidates (hard-deletable) – mirror `/api/admin/profiles/orphans` definition (sampled).
  // Selectivity-first: prune to deleted + unowned + un-orged profiles in a CTE
  // (cheap, indexed via idx_profiles_status), then attach child counts with four
  // GROUPED LEFT JOINs instead of 12 per-row correlated subqueries. Same
  // semantics (filter on counts, then order, then limit) at a fraction of the
  // cost — this query was the integrity endpoint's 504 root cause. CTE is
  // supported on both Postgres and SQLite.
  const orphanRows = await safeAll(
    `
      WITH cand AS (
        SELECT
          p.id, p.display_name, p.primary_type, p.status, p.created_at, p.updated_at, p.user_id, p.organization_id
        FROM profiles p
        WHERE (p.status IS NOT NULL AND lower(p.status) = 'deleted')
          AND (p.user_id IS NULL OR TRIM(p.user_id) = '')
          AND (p.organization_id IS NULL OR TRIM(p.organization_id) = '')
      )
      SELECT
        c.id, c.display_name, c.primary_type, c.status, c.created_at, c.updated_at, c.user_id, c.organization_id,
        COALESCE(ps.cnt, 0) AS section_count,
        COALESCE(pd.cnt, 0) AS profile_document_count,
        COALESCE(d.cnt, 0)  AS document_count,
        COALESCE(g.cnt, 0)  AS grant_count
      FROM cand c
      LEFT JOIN (SELECT profile_id, COUNT(*) AS cnt FROM profile_sections GROUP BY profile_id) ps ON ps.profile_id = c.id
      LEFT JOIN (SELECT profile_id, COUNT(*) AS cnt FROM profile_documents GROUP BY profile_id) pd ON pd.profile_id = c.id
      LEFT JOIN (SELECT profile_id, COUNT(*) AS cnt FROM documents GROUP BY profile_id) d ON d.profile_id = c.id
      LEFT JOIN (SELECT profile_id, COUNT(*) AS cnt FROM grants GROUP BY profile_id) g ON g.profile_id = c.id
      WHERE COALESCE(ps.cnt, 0) < 2
        AND COALESCE(pd.cnt, 0) = 0
        AND COALESCE(d.cnt, 0) = 0
        AND COALESCE(g.cnt, 0) = 0
      ORDER BY c.updated_at DESC
      LIMIT ?
    `,
    [limitOrphans],
  )

  const orphanCandidates = Array.isArray(orphanRows)
    ? orphanRows.filter((r) => !isDesignatedProfileId(r?.id))
    : null

  // Duplicate groups (heuristic): group by email/phone when present, else name key.
  let duplicates = null
  try {
    duplicates = await findDuplicateProfileGroups(req.db, {
      strategy: 'email_or_phone',
      limitGroups: limitDuplicateGroups,
      minGroupSize: 2,
      includeInactive,
    })
  } catch (e) {
    errors.push({ type: 'dedupe_failed', message: e?.message || String(e) })
  }

  if (typeof unownedProfiles === 'number' && unownedProfiles > 0) {
    warnings.push({
      type: 'unowned_profiles',
      message: `Found ${unownedProfiles} profiles with no user_id (ownership missing).`,
    })
  }
  if (typeof missingUserLinks === 'number' && missingUserLinks > 0) {
    warnings.push({
      type: 'dangling_user_links',
      message: `Found ${missingUserLinks} profiles whose user_id does not exist in users table.`,
    })
  }
  if (typeof missingOrgLinks === 'number' && missingOrgLinks > 0) {
    warnings.push({
      type: 'dangling_org_links',
      message: `Found ${missingOrgLinks} profiles whose organization_id does not exist in organizations table.`,
    })
  }
  if (Array.isArray(orphanCandidates) && orphanCandidates.length > 0) {
    warnings.push({
      type: 'hard_deletable_orphans',
      message: `Found ${orphanCandidates.length} hard-deletable orphan profiles (sampled up to limitOrphans).`,
      hint: 'See /api/admin/profiles/orphans for a paginated list and /api/admin/profiles/orphans/cleanup to clean up.',
    })
  }

  return res.json({
    ok: true,
    generated_at: generatedAt,
    limits: { limitOwners, limitOrphans, limitDuplicateGroups, includeInactive },
    totals: {
      profiles: totalProfiles,
      organizations: totalOrganizations,
      users: totalUsers,
    },
    profiles: {
      by_status: Array.isArray(byStatusRows) ? byStatusRows : null,
      by_primary_type: Array.isArray(byPrimaryTypeRows) ? byPrimaryTypeRows : null,
      unowned: unownedProfiles,
      dangling_user_links: missingUserLinks,
      dangling_org_links: missingOrgLinks,
      top_owners: Array.isArray(owners) ? owners : null,
    },
    orphans: {
      sampled: Array.isArray(orphanCandidates) ? orphanCandidates.length : null,
      candidates: orphanCandidates,
    },
    duplicates: duplicates
      ? {
          strategy: 'email_or_phone',
          includeInactive,
          groups: duplicates.groups ?? [],
        }
      : null,
    warnings,
    errors,
  })
})

/**
 * POST /api/admin/profiles/integrity/repair
 *
 * Admin-only: take action on integrity issues in a traceable + reversible way.
 * - Dry-run by default.
 * - Logs an audit summary event.
 *
 * Body:
 * {
 *   dry_run?: boolean = true,
 *   actions?: {
 *     reattach_unowned_by_email?: boolean = true,
 *     fix_dangling_user_links_by_email?: boolean = true,
 *     cleanup_orphan_profiles?: boolean = false,
 *   },
 *   limits?: {
 *     reattach?: number = 2000,
 *     cleanup_orphans?: number = 200,
 *   },
 *   options?: {
 *     include_deleted_profiles?: boolean = false,
 *     allow_attach_to_admin?: boolean = false,
 *     tombstone_orphans?: boolean = true,
 *     reason?: string,
 *   }
 * }
 */
router.post('/profiles/integrity/repair', async (req, res) => {
  if (!(await ensureAdminRequest(req, res))) return

  const dryRun = req.body?.dry_run !== false

  const actions = req.body?.actions && typeof req.body.actions === 'object' ? req.body.actions : {}
  const doReattach = actions.reattach_unowned_by_email !== false
  const doFixDangling = actions.fix_dangling_user_links_by_email !== false
  const doCleanupOrphans = actions.cleanup_orphan_profiles === true

  const limits = req.body?.limits && typeof req.body.limits === 'object' ? req.body.limits : {}
  const limitReattach = Math.max(1, Math.min(Number(limits.reattach) || 2000, 20_000))
  const limitCleanupOrphans = Math.max(1, Math.min(Number(limits.cleanup_orphans) || 200, 2000))

  const options = req.body?.options && typeof req.body.options === 'object' ? req.body.options : {}
  const includeDeleted = options.include_deleted_profiles === true
  const allowAttachToAdmin = options.allow_attach_to_admin === true
  const tombstoneOrphans = options.tombstone_orphans !== false
  const reason =
    typeof options.reason === 'string' && options.reason.trim()
      ? options.reason.trim()
      : 'integrity_repair'

  const actorUserId = req.ctx?.userId ?? req.user?.userId ?? null

  const generatedAt = new Date().toISOString()
  const warnings = []
  const errors = []

  const result = {
    ok: true,
    dry_run: dryRun,
    generated_at: generatedAt,
    actions: {
      reattach_unowned_by_email: doReattach,
      fix_dangling_user_links_by_email: doFixDangling,
      cleanup_orphan_profiles: doCleanupOrphans,
    },
    limits: { reattach: limitReattach, cleanup_orphans: limitCleanupOrphans },
    options: {
      include_deleted_profiles: includeDeleted,
      allow_attach_to_admin: allowAttachToAdmin,
      tombstone_orphans: tombstoneOrphans,
      reason,
    },
    reattach: null,
    cleanup_orphans: null,
    warnings,
    errors,
  }

  const chooseUserForEmails = ({ emails, usersByEmail }) => {
    const matched = []
    for (const e of emails || []) {
      const u = usersByEmail.get(String(e))
      if (u) matched.push(u)
    }
    const uniqById = new Map(matched.map((u) => [String(u.id), u]))
    const uniq = Array.from(uniqById.values())
    const nonAdmin = uniq.filter((u) => !(u.is_admin === true || u.is_admin === 1))
    const admin = uniq.filter((u) => u.is_admin === true || u.is_admin === 1)

    if (nonAdmin.length === 1) return { user: nonAdmin[0], matched: uniq }
    if (nonAdmin.length > 1) return { user: null, matched: uniq, ambiguous: true }

    if (allowAttachToAdmin && admin.length === 1) return { user: admin[0], matched: uniq }
    if (admin.length > 0) return { user: null, matched: uniq, blocked_admin: true }

    return { user: null, matched: [] }
  }

  const safeAll = async (sql, params = []) => {
    try {
      return await req.db.prepare(sql).all(...params)
    } catch (e) {
      errors.push({ type: 'query_failed', sql, message: e?.message || String(e) })
      return null
    }
  }

  // ---- Action 1/2: reattach unowned + fix dangling user links via email signals ----
  if (doReattach || doFixDangling) {
    const whereNotDeleted = includeDeleted ? '' : "AND (p.status IS NULL OR lower(p.status) <> 'deleted')"

    const unownedRows = doReattach
      ? await safeAll(
          `
            SELECT p.id, p.display_name, p.status, p.user_id
            FROM profiles p
            WHERE (p.user_id IS NULL OR TRIM(p.user_id) = '')
              ${whereNotDeleted}
            ORDER BY COALESCE(p.updated_at, p.created_at) DESC
            LIMIT ?
          `,
          [limitReattach],
        )
      : []

    const danglingRows = doFixDangling
      ? await safeAll(
          `
            SELECT p.id, p.display_name, p.status, p.user_id
            FROM profiles p
            LEFT JOIN users u ON u.id = p.user_id
            WHERE p.user_id IS NOT NULL AND TRIM(p.user_id) <> ''
              AND u.id IS NULL
              ${whereNotDeleted}
            ORDER BY COALESCE(p.updated_at, p.created_at) DESC
            LIMIT ?
          `,
          [limitReattach],
        )
      : []

    const candidates = []
    for (const r of (unownedRows || [])) {
      if (!r?.id || isDesignatedProfileId(r.id)) continue
      candidates.push({ profile_id: String(r.id), display_name: r.display_name ?? null, status: r.status ?? null, current_user_id: null })
    }
    for (const r of (danglingRows || [])) {
      if (!r?.id || isDesignatedProfileId(r.id)) continue
      candidates.push({
        profile_id: String(r.id),
        display_name: r.display_name ?? null,
        status: r.status ?? null,
        current_user_id: r.user_id ? String(r.user_id) : null,
      })
    }

    const uniqueProfileIds = Array.from(new Set(candidates.map((c) => c.profile_id)))
    const emailSignalsByProfile = await loadProfileEmailSignals(req.db, uniqueProfileIds)

    const allEmails = Array.from(
      new Set(
        Array.from(emailSignalsByProfile.values())
          .flatMap((set) => Array.from(set || []))
          .filter(Boolean),
      ),
    )

    const usersByEmail = new Map()
    if (allEmails.length > 0) {
      const placeholders = allEmails.map(() => '?').join(', ')
      const userRows = await safeAll(
        `
          SELECT id, primary_email, is_admin, display_name
          FROM users
          WHERE lower(primary_email) IN (${placeholders})
        `,
        allEmails,
      )
      for (const u of userRows || []) {
        const email = normalizeEmail(u?.primary_email)
        if (!email) continue
        usersByEmail.set(email, u)
      }
    }

    const plan = []
    const skipped = {
      no_email: 0,
      no_match: 0,
      ambiguous: 0,
      blocked_admin: 0,
    }

    for (const c of candidates) {
      const emails = Array.from(emailSignalsByProfile.get(c.profile_id) || [])
      if (emails.length === 0) {
        skipped.no_email += 1
        continue
      }
      const pick = chooseUserForEmails({ emails, usersByEmail })
      if (pick?.ambiguous) {
        skipped.ambiguous += 1
        continue
      }
      if (pick?.blocked_admin) {
        skipped.blocked_admin += 1
        continue
      }
      const user = pick?.user || null
      if (!user?.id) {
        skipped.no_match += 1
        continue
      }

      plan.push({
        action: 'set_profile_user_id',
        profile_id: c.profile_id,
        display_name: c.display_name ?? null,
        status: c.status ?? null,
        from_user_id: c.current_user_id,
        to_user_id: String(user.id),
        matched_email: normalizeEmail(user.primary_email),
        reason: 'email_signal_match',
      })
    }

    let applied = 0
    const appliedIds = []

    if (!dryRun && plan.length > 0) {
      await req.db.withTransaction(async (tx) => {
        const setUnowned = tx.prepare(
          `
            UPDATE profiles
            SET user_id = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
              AND (user_id IS NULL OR TRIM(user_id) = '')
          `,
        )
        const setDangling = tx.prepare(
          `
            UPDATE profiles
            SET user_id = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
              AND user_id = ?
          `,
        )

        for (const step of plan) {
          const toId = String(step.to_user_id)
          const pid = String(step.profile_id)
          if (!toId || !pid) continue

          const fromId = step.from_user_id ? String(step.from_user_id) : null
          const res = fromId ? await setDangling.run(toId, pid, fromId) : await setUnowned.run(toId, pid)
          if (Number(res?.changes || 0) > 0) {
            applied += 1
            appliedIds.push(pid)
          }
        }
      })
    }

    result.reattach = {
      planned: plan.length,
      applied,
      applied_profile_ids: appliedIds,
      skipped,
      plan: plan.slice(0, 500), // cap payload; full details can be re-run
      note:
        plan.length > 500
          ? `Plan truncated to 500 items in response; re-run with tighter filters if needed.`
          : null,
    }

    if (plan.length > 0 && dryRun) {
      warnings.push({
        type: 'dry_run',
        message: `Dry-run: ${plan.length} profile ownership updates are planned. Re-run with dry_run=false to apply.`,
      })
    }
  }

  // ---- Action 3: orphan cleanup wrapper (hard-delete) ----
  if (doCleanupOrphans) {
    const orphanRows = await safeAll(
      `
        SELECT
          p.id, p.display_name, p.primary_type, p.status, p.created_at, p.updated_at, p.user_id, p.organization_id,
          (SELECT COUNT(*) FROM profile_sections ps WHERE ps.profile_id = p.id) AS section_count,
          (SELECT COUNT(*) FROM profile_documents pd WHERE pd.profile_id = p.id) AS profile_document_count,
          (SELECT COUNT(*) FROM documents d WHERE d.profile_id = p.id) AS document_count,
          (SELECT COUNT(*) FROM grants g WHERE g.profile_id = p.id) AS grant_count
        FROM profiles p
        WHERE (p.status IS NOT NULL AND lower(p.status) = 'deleted')
          AND (p.user_id IS NULL OR TRIM(p.user_id) = '')
          AND (p.organization_id IS NULL OR TRIM(p.organization_id) = '')
          AND (SELECT COUNT(*) FROM profile_sections ps WHERE ps.profile_id = p.id) < 2
          AND (SELECT COUNT(*) FROM profile_documents pd WHERE pd.profile_id = p.id) = 0
          AND (SELECT COUNT(*) FROM documents d WHERE d.profile_id = p.id) = 0
          AND (SELECT COUNT(*) FROM grants g WHERE g.profile_id = p.id) = 0
        ORDER BY p.updated_at DESC
        LIMIT ?
      `,
      [limitCleanupOrphans],
    )

    const candidates = Array.isArray(orphanRows)
      ? orphanRows.filter((r) => !isDesignatedProfileId(r?.id))
      : null

    if (dryRun) {
      result.cleanup_orphans = {
        dry_run: true,
        would_delete: Array.isArray(candidates) ? candidates.length : 0,
        candidates,
      }
    } else {
      const ids = Array.isArray(candidates) ? candidates.map((c) => String(c.id)).filter(Boolean) : []
      let deleted = 0
      const deletedIds = []
      for (const id of ids) {
        await hardDeleteProfileById({
          db: req.db,
          profileId: id,
          actorUserId,
          reason,
          tombstone: tombstoneOrphans,
        })
        deleted += 1
        deletedIds.push(id)
      }
      result.cleanup_orphans = {
        dry_run: false,
        deleted,
        deleted_ids: deletedIds,
      }
    }
  }

  // Audit summary (best-effort; do not block response)
  try {
    logAuditEvent(req.db, {
      category: AUDIT_CATEGORIES.ADMIN,
      action: 'integrity_repair',
      severity: SEVERITY.INFO,
      userId: actorUserId,
      resourceType: 'profile',
      resourceId: null,
      details: {
        dry_run: dryRun,
        actions: result.actions,
        limits: result.limits,
        options: result.options,
        reattach: result.reattach
          ? {
              planned: result.reattach.planned,
              applied: result.reattach.applied,
              skipped: result.reattach.skipped,
            }
          : null,
        cleanup_orphans: result.cleanup_orphans
          ? dryRun
            ? { would_delete: result.cleanup_orphans.would_delete }
            : { deleted: result.cleanup_orphans.deleted }
          : null,
      },
      ipAddress: req.ip || null,
      userAgent: req.headers['user-agent'] || null,
    })
  } catch {
    // ignore
  }

  return res.json(result)
})

/**
 * POST /api/admin/profiles/ownership/repair
 *
 * Admin-only: enforce the ownership/linking rules:
 * - Every profile is linked to ADMIN_EMAIL via profile_emails (so "My Profiles" can show all for the operator).
 * - Individual profiles are linked to their basic_information.email via profile_emails.
 * - Ownership (profiles.user_id) is assigned to the user matching that email when safe (respects unique ownership).
 *
 * Body:
 * {
 *   dry_run?: boolean = true,
 *   limit?: number = 5000,
 *   include_deleted_profiles?: boolean = true
 * }
 */
router.post('/profiles/ownership/repair', async (req, res) => {
  if (!(await ensureAdminRequest(req, res))) return

  const dryRun = req.body?.dry_run !== false
  const limit = Math.max(1, Math.min(Number(req.body?.limit) || 5000, 50_000))
  const includeDeleted = req.body?.include_deleted_profiles !== false

  const actorUserId = req.ctx?.userId ?? req.user?.userId ?? null
  const generatedAt = new Date().toISOString()

  let report = null
  try {
    report = await repairProfileOwnership(req.db, {
      apply: !dryRun,
      limit,
      includeDeleted,
      updatedBy: actorUserId || 'admin-ownership-repair',
    })
  } catch (error) {
    routeLogger.error('[admin/profiles/ownership/repair] failed', error)
    return res.status(500).json({
      ok: false,
      error: error?.message || String(error),
      error_type: 'ownership_repair_failed',
    })
  }

  // Audit summary (best-effort; do not block response)
  try {
    logAuditEvent(req.db, {
      category: AUDIT_CATEGORIES.ADMIN,
      action: 'profile_ownership_repair',
      severity: SEVERITY.INFO,
      userId: actorUserId,
      resourceType: 'profile',
      resourceId: null,
      details: {
        dry_run: dryRun,
        include_deleted_profiles: includeDeleted,
        limit,
        report: {
          scanned: report?.scanned ?? null,
          admin_links_added: report?.admin_links_added ?? null,
          profile_email_links_added: report?.profile_email_links_added ?? null,
          ownership_assigned: report?.ownership_assigned ?? null,
          ownership_skipped: report?.ownership_skipped ?? null,
        },
      },
      ipAddress: req.ip || null,
      userAgent: req.headers['user-agent'] || null,
    })
  } catch {
    // ignore
  }

  return res.json({
    ok: true,
    generated_at: generatedAt,
    dry_run: dryRun,
    ...report,
  })
})

// POST /api/admin/seed-opportunities - Seed real funding opportunities
router.post('/seed-opportunities', async (req, res) => {
  try {
    if (!(await ensureAdminRequest(req, res))) return;
    const { totalLoaded } = seedRealOpportunities(req.db);
    const totalInDb = Number((await req.db.prepare('SELECT COUNT(*) as count FROM funding_opportunities').get())?.count || 0);
    res.json({ success: true, message: `Seeded ${totalLoaded} opportunities`, total_in_database: totalInDb, loaded_from_files: totalLoaded });
  } catch (error) {
    console.error('[admin/seed-opportunities] Error:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to seed opportunities' });
  }
});

// POST /api/admin/seed-assistance-directories - Seed state 211 + national assistance directories
router.post('/seed-assistance-directories', async (req, res) => {
  try {
    if (!(await ensureAdminRequest(req, res))) return;
    const before = Number(
      (await req.db
        .prepare("SELECT COUNT(*) as count FROM funding_opportunities WHERE source IN ('state_211','assistance_network')")
        .get())?.count || 0,
    );
    const result = await seedAssistanceDirectories(req.db);
    const after = Number(
      (await req.db
        .prepare("SELECT COUNT(*) as count FROM funding_opportunities WHERE source IN ('state_211','assistance_network')")
        .get())?.count || 0,
    );
    res.json({
      success: true,
      message: `Seeded assistance directories. Records: ${before} → ${after}.`,
      before,
      after,
      ...result,
    });
  } catch (error) {
    console.error('[admin/seed-assistance-directories] Error:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to seed assistance directories' });
  }
});

// POST /api/admin/repair-all-profiles - Repair all profiles by creating missing sections
router.post('/repair-all-profiles', async (req, res) => {
  try {
    if (!(await ensureAdminRequest(req, res))) return;

    // Import canonical sections
    const { supportedSectionKeys } = await import('../prompts/profileSections.js');
    const { getDefaultSectionData } = await import('../config/profileSchema.js')

    // Get all profiles
    const profiles = await req.db.prepare('SELECT id, display_name FROM profiles').all();

    const results = {
      profiles_processed: 0,
      sections_created: 0,
      keys_repaired: 0,
      details: []
    };

    await req.db.withTransaction(async (tx) => {
      const insertMissing = tx.prepare(`
        INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
        VALUES (?, ?, ?, 'admin-repair')
        ON CONFLICT(profile_id, section_key) DO NOTHING
      `)

      const selectSections = tx.prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?')
      const updateSection = tx.prepare(`
        UPDATE profile_sections
        SET data = ?, updated_by = 'admin-repair', updated_at = CURRENT_TIMESTAMP
        WHERE profile_id = ? AND section_key = ?
      `)

      for (const profile of profiles) {
        const rows = await selectSections.all(profile.id)
        const existingMap = new Map(rows.map((r) => [r.section_key, r.data]))

        const createdForProfile = []
        let repairedKeysForProfile = 0

        for (const sectionKey of supportedSectionKeys) {
          const defaults = getDefaultSectionData(sectionKey) ?? {}
          const existingRaw = existingMap.get(sectionKey)

          if (!existingRaw) {
            await insertMissing.run(profile.id, sectionKey, JSON.stringify(defaults))
            createdForProfile.push(sectionKey)
            repairedKeysForProfile += Object.keys(defaults).length
            continue
          }

          let current = {}
          try {
            current = existingRaw ? JSON.parse(existingRaw) : {}
          } catch {
            current = {}
          }

          let changed = false
          for (const [key, defaultValue] of Object.entries(defaults)) {
            if (!Object.prototype.hasOwnProperty.call(current, key)) {
              current[key] = defaultValue
              changed = true
              repairedKeysForProfile += 1
            }
          }

          if (changed) {
            await updateSection.run(JSON.stringify(current), profile.id, sectionKey)
          }
        }

        results.profiles_processed++
        results.sections_created += createdForProfile.length
        results.keys_repaired += repairedKeysForProfile

        if (createdForProfile.length > 0 || repairedKeysForProfile > 0) {
          results.details.push({
            profile_id: profile.id,
            display_name: profile.display_name,
            sections_created: createdForProfile.length,
            keys_repaired: repairedKeysForProfile,
          })
        }
      }
    })

    // Log audit event
    try {
      await req.db.prepare(`
        INSERT INTO audit_logs (event_type, user_id, details, created_at)
        VALUES ('admin_repair_all_profiles', ?, ?, CURRENT_TIMESTAMP)
      `).run(
        req.user?.userId ?? 'admin',
        JSON.stringify({
          profiles_processed: results.profiles_processed,
          sections_created: results.sections_created,
          keys_repaired: results.keys_repaired,
          timestamp: new Date().toISOString()
        })
      );
    } catch (auditError) {
      console.warn('[admin/repair-all-profiles] Audit log failed:', auditError.message);
    }

    res.json({
      success: true,
      message: `Repaired ${results.profiles_processed} profiles, created ${results.sections_created} sections`,
      ...results
    });
  } catch (error) {
    console.error('[admin/repair-all-profiles] Error:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to repair profiles' });
  }
});

// POST /api/admin/sync-profiles - Sync designated profiles
router.post('/sync-profiles', async (req, res) => {
  try {
    if (!(await ensureAdminRequest(req, res))) return;
    await ensureDesignatedProfiles(req.db);
    const profilesCount = Number((await req.db.prepare('SELECT COUNT(*) as count FROM profiles').get())?.count || 0);
    const sectionsCount = Number((await req.db.prepare('SELECT COUNT(*) as count FROM profile_sections').get())?.count || 0);
    res.json({ success: true, message: 'Profiles synchronized', profiles: profilesCount, total_sections: sectionsCount });
  } catch (error) {
    console.error('[admin/sync-profiles] Error:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to sync profiles' });
  }
});

// POST /api/admin/seed-baseline-profiles
// Upsert baseline data from `seed/baseline-profiles.json` (production-safe, idempotent).
// Supports X-Seed-Key header for authenticated CLI seeding without session auth (requires SEED_KEY env var).
router.post('/seed-baseline-profiles', async (req, res) => {
  try {
    const seedKey = req.headers['x-seed-key'] || req.body?.seed_key;
    const expectedSeedKey = process.env.SEED_KEY || null;
    const isSeedKeyValid = Boolean(expectedSeedKey && seedKey && seedKey === expectedSeedKey);

    if (!isSeedKeyValid && !(await ensureAdminRequest(req, res))) return;

    const mode = String(req.body?.mode || '').trim().toLowerCase() || 'force'
    const result = await seedBaselineFromRepo(req.db, {
      mode: mode === 'off' ? 'off' : mode === 'auto' ? 'auto' : 'force',
    })

    res.json({
      success: true,
      seeded: result.skipped === false,
      ...result,
    })
  } catch (error) {
    console.error('[admin/seed-baseline-profiles] Error:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to seed baseline profiles' });
  }
});

// POST /api/admin/seed-profile-grants - Seed grants for profiles
router.post('/seed-profile-grants', async (req, res) => {
  // Safety guard: refuse to seed in production to prevent fake/random scores from affecting users.
  const nodeEnv = String(process.env.NODE_ENV || '').trim().toLowerCase()
  if (nodeEnv === 'production') {
    return res.status(403).json({ success: false, error: 'Seeding is disabled in production.' })
  }
  try {
    const { excludeProfiles = [] } = req.body || {};
    const { computeMatchDecision } = await import('../services/matchEngine.js');
    const { saveToProfilePipeline } = await import('../services/opportunityMatcher.js');
    const { ADMIN_SEED_MIN_SCORE } = await import('../config/matchThresholds.js');
    const { RELEVANCE_FLOOR } = await import('../startup/enforceInvariants.js');
    // ADMIN_SEED_MIN_SCORE (45) is below the canonical pipeline relevance floor.
    // Never persist below the floor — clamp the threshold handed to the saver so
    // this owner-only seed endpoint can't smuggle sub-floor rows into a profile
    // pipeline (the saver's own hard floor is the net behind this).
    const seedSaveThreshold = Math.max(ADMIN_SEED_MIN_SCORE, RELEVANCE_FLOOR);

    const profiles = await req.db.prepare('SELECT * FROM profiles WHERE status = ?').all('active');
    const opportunities = await req.db.prepare(`
      SELECT * FROM funding_opportunities 
      WHERE is_active = ?
      AND (requires_match = FALSE OR requires_match IS NULL)
      LIMIT 500
    `).all(true);

    let totalGrantsAdded = 0;
    const results = [];

    for (const profile of profiles) {
      const displayName = (profile.display_name || '').toLowerCase();
      if (excludeProfiles.some(excluded => displayName.includes(excluded.toLowerCase()))) {
        results.push({ profile: profile.display_name, status: 'skipped', opportunities_found: 0, grants_added: 0 });
        continue;
      }

      const sections = {};
      const sectionRows = await req.db
        .prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?')
        .all(profile.id);
      sectionRows.forEach(row => {
        try { sections[row.section_key] = JSON.parse(row.data || '{}'); } catch (e) { sections[row.section_key] = {}; }
      });

      const profileContext = { profile, sections };

      // Pre-score all opportunities through the canonical decision engine
      const candidates = opportunities
        .map(opp => {
          const decision = computeMatchDecision(profile, opp, { profileSections: sections });
          return { opp, decision };
        })
        .filter(({ decision }) => decision.decision !== 'REJECT' && decision.score >= ADMIN_SEED_MIN_SCORE)
        .sort((a, b) => b.decision.score - a.decision.score)
        .slice(0, 50);

      let added = 0;
      for (const { opp, decision } of candidates) {
        const result = await saveToProfilePipeline(
          req.db,
          opp,
          profile.id,
          profileContext,
          decision.score,
          seedSaveThreshold,
        );
        if (result.saved) added++;
      }
      results.push({ profile: profile.display_name, status: 'seeded', opportunities_found: candidates.length, grants_added: added });
      totalGrantsAdded += added;
    }
    res.json({ success: true, message: 'Profile seeding complete', results, total_grants_added: totalGrantsAdded });
  } catch (error) {
    console.error('[admin/seed-profile-grants] Error:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to seed profile grants' });
  }
});

// POST /api/admin/ingest - Trigger ingestion from all sources
router.post('/ingest', async (req, res) => {
  try {
    routeLogger.info('[admin/ingest] Starting manual ingestion...');

    // Import connectors dynamically.
    //
    // HISTORICAL BUG: this block used to import `fetchSamGov` from
    // services/sources/samGov.js and alias it as `fetchGrantsGov`. That
    // means "grants.gov" in the admin ingest UI was actually hitting SAM.gov,
    // which requires SAM_GOV_API_KEY and silently returned 0 rows whenever
    // the key was missing. The canonical grants.gov v2/search2 client at
    // backend/services/connectors/grantsGovConnector.js needs no key and
    // returns real posted opportunities. Wire that in instead and keep
    // SAM.gov as its own optional source.
    const { searchOpportunities: fetchGrantsGov } = await import(
      '../services/connectors/grantsGovConnector.js'
    );
    const { fetchUSASpending } = await import('../services/sources/usaSpending.js');
    const { fetchOpportunities: fetchNihReporter } = await import(
      '../src/integrations/nihReporter.js'
    );
    const { ingestOpportunities } = await import('../services/sources/ingestionService.js');

    const results = [];

    // Ingest from Grants.gov (real public v2/search2 endpoint — no key required).
    try {
      routeLogger.info('[admin/ingest] Fetching from Grants.gov...');
      const grantsGovOpps = await fetchGrantsGov({ rows: 100 });
      const grantsGovResult = await ingestOpportunities(req.db, grantsGovOpps, 'grants.gov');
      results.push({ source: 'grants.gov', ...grantsGovResult });
    } catch (error) {
      console.error('[admin/ingest] Grants.gov error:', error.message);
      results.push({ source: 'grants.gov', success: false, error: error.message });
    }

    // Ingest from USASpending.gov
    try {
      routeLogger.info('[admin/ingest] Fetching from USASpending.gov...');
      const { opportunities: usaSpendingOpps } = await fetchUSASpending({ limit: 100, page: 1 });
      const usaSpendingResult = await ingestOpportunities(req.db, usaSpendingOpps, 'usaspending.gov');
      results.push({ source: 'usaspending.gov', ...usaSpendingResult });
    } catch (error) {
      console.error('[admin/ingest] USASpending.gov error:', error.message);
      results.push({ source: 'usaspending.gov', success: false, error: error.message });
    }

    // Ingest from NIH RePORTER (real API, no key required)
    try {
      routeLogger.info('[admin/ingest] Fetching from NIH RePORTER...');
      const nihOpps = await fetchNihReporter({ limit: 100, offset: 0 });
      const nihResult = await ingestOpportunities(req.db, nihOpps, 'nih.reporter');
      results.push({ source: 'nih.reporter', ...nihResult });
    } catch (error) {
      console.error('[admin/ingest] NIH RePORTER error:', error.message);
      results.push({ source: 'nih.reporter', success: false, error: error.message });
    }

    // Calculate totals
    const summary = {
      sources_processed: results.length,
      successes: results.filter(r => r.success).length,
      failures: results.filter(r => !r.success).length,
      total_inserted: results.reduce((sum, r) => sum + (r.records_inserted || 0), 0),
      total_updated: results.reduce((sum, r) => sum + (r.records_updated || 0), 0),
      total_rejected_policy: results.reduce((sum, r) => sum + (r.records_rejected_policy || 0), 0),
      total_rejected_reviewer: results.reduce((sum, r) => sum + (r.records_rejected_reviewer || 0), 0),
      total_errors: results.reduce((sum, r) => sum + (r.errors || 0), 0),
    };
    
    routeLogger.info('[admin/ingest] Ingestion completed:', summary);
    
    res.json({
      success: summary.failures === 0,
      message: `Ingestion completed: ${summary.total_inserted} inserted, ${summary.total_updated} updated`,
      summary,
      results,
    });
  } catch (error) {
    console.error('[admin/ingest] Error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to run ingestion',
    });
  }
});

// POST /api/admin/link-admin-to-organizations - Link admin to all organizations
router.post('/link-admin-to-organizations', async (req, res) => {
  try {
    const adminUser = await req.db.prepare('SELECT id FROM users WHERE is_admin = TRUE LIMIT 1').get();
    if (!adminUser) {
      return res.status(404).json({ success: false, error: 'Admin user not found' });
    }

    const organizations = await req.db.prepare('SELECT id FROM organizations').all();
    let linkedCount = 0;

    for (const org of organizations) {
      try {
        const existingLink = await req.db
          .prepare('SELECT 1 FROM user_organizations WHERE user_id = ? AND organization_id = ?')
          .get(adminUser.id, org.id);
        if (!existingLink) {
          await req.db
            .prepare('INSERT INTO user_organizations (user_id, organization_id) VALUES (?, ?)')
            .run(adminUser.id, org.id);
          linkedCount++;
        }
      } catch (e) { /* ignore */ }
    }
    res.json({ success: true, message: `Admin user linked to ${linkedCount} organizations.` });
  } catch (error) {
    console.error('[admin/link-admin-to-organizations] Error:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to link admin to organizations' });
  }
});

// ============================================================================
// Audit Log Endpoints
// ============================================================================

/**
 * Query audit logs
 * GET /api/admin/audit-logs
 */
router.get('/audit-logs', async (req, res) => {
  try {
    if (!(await ensureAdminRequest(req, res))) return;
    
    const {
      category,
      action,
      severity,
      userId,
      resourceType,
      resourceId,
      startDate,
      endDate,
      limit = 100,
      offset = 0,
    } = req.query;
    
    const result = await queryAuditLogs(req.db, {
      category,
      action,
      severity,
      userId,
      resourceType,
      resourceId,
      startDate,
      endDate,
      limit: Math.min(parseInt(limit) || 100, 500),
      offset: parseInt(offset) || 0,
    });
    
    res.json(result);
  } catch (error) {
    console.error('[admin/audit-logs] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get audit summary
 * GET /api/admin/audit-logs/summary
 */
router.get('/audit-logs/summary', async (req, res) => {
  try {
    if (!(await ensureAdminRequest(req, res))) return;
    
    const days = Math.min(parseInt(req.query.days) || 7, 90);
    const summary = await getAuditSummary(req.db, { days });
    
    res.json(summary);
  } catch (error) {
    console.error('[admin/audit-logs/summary] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Cleanup old audit logs
 * POST /api/admin/audit-logs/cleanup
 */
router.post('/audit-logs/cleanup', async (req, res) => {
  try {
    if (!(await ensureAdminRequest(req, res))) return;
    
    const retentionDays = Math.min(parseInt(req.body.retentionDays) || 90, 365);
    const result = await cleanupAuditLogs(req.db, { retentionDays });
    
    // Log the cleanup action
    logAuditEvent(req.db, {
      category: AUDIT_CATEGORIES.ADMIN,
      action: 'audit_cleanup',
      userId: req.user?.userId,
      details: { retentionDays, deleted: result.deleted },
    });
    
    res.json(result);
  } catch (error) {
    console.error('[admin/audit-logs/cleanup] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// Feature Flag Endpoints
// ============================================================================

/**
 * Initialize feature flags (creates tables and seeds defaults)
 * POST /api/admin/feature-flags/init
 */
router.post('/feature-flags/init', async (req, res) => {
  try {
    if (!(await ensureAdminRequest(req, res))) return;
    
    initializeFeatureFlags(req.db);
    
    logAuditEvent(req.db, {
      category: AUDIT_CATEGORIES.ADMIN,
      action: 'feature_flags_init',
      userId: req.user?.userId,
    });
    
    res.json({ success: true, message: 'Feature flags initialized' });
  } catch (error) {
    console.error('[admin/feature-flags/init] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get all feature flags
 * GET /api/admin/feature-flags
 */
router.get('/feature-flags', async (req, res) => {
  try {
    if (!(await ensureAdminRequest(req, res))) return;
    
    const flags = getAllFlags(req.db);
    res.json({ flags });
  } catch (error) {
    console.error('[admin/feature-flags] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Check if a specific feature is enabled
 * GET /api/admin/feature-flags/:key/check
 */
router.get('/feature-flags/:key/check', async (req, res) => {
  try {
    const { key } = req.params;
    const { userId, profileId } = req.query;
    
    const adminCheck = req.ctx?.isAdmin === true;
    const enabled = isFeatureEnabled(req.db, key, {
      userId: userId || req.user?.userId,
      profileId: profileId || req.user?.profileId,
      isAdmin: adminCheck,
    });
    
    res.json({ key, enabled });
  } catch (error) {
    console.error('[admin/feature-flags/check] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Update a feature flag
 * PATCH /api/admin/feature-flags/:key
 */
router.patch('/feature-flags/:key', async (req, res) => {
  try {
    if (!(await ensureAdminRequest(req, res))) return;
    
    const { key } = req.params;
    const { enabled, description, percentage, metadata } = req.body;
    
    const result = updateFlag(req.db, key, { enabled, description, percentage, metadata });
    
    logAuditEvent(req.db, {
      category: AUDIT_CATEGORIES.ADMIN,
      action: 'feature_flag_update',
      userId: req.user?.userId,
      resourceType: 'feature_flag',
      resourceId: key,
      details: { enabled, percentage },
    });
    
    res.json(result);
  } catch (error) {
    console.error('[admin/feature-flags/update] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Create flag override for user/profile
 * POST /api/admin/feature-flags/:key/override
 */
router.post('/feature-flags/:key/override', async (req, res) => {
  try {
    if (!(await ensureAdminRequest(req, res))) return;
    
    const { key } = req.params;
    const { userId, profileId, enabled, expiresInDays } = req.body;
    
    const result = createFlagOverride(req.db, key, {
      userId,
      profileId,
      enabled,
      expiresInDays,
    });
    
    logAuditEvent(req.db, {
      category: AUDIT_CATEGORIES.ADMIN,
      action: 'feature_flag_override_create',
      userId: req.user?.userId,
      resourceType: 'feature_flag',
      resourceId: key,
      details: { targetUserId: userId, targetProfileId: profileId, enabled },
    });
    
    res.json(result);
  } catch (error) {
    console.error('[admin/feature-flags/override] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Remove flag override
 * DELETE /api/admin/feature-flags/:key/override
 */
router.delete('/feature-flags/:key/override', async (req, res) => {
  try {
    if (!(await ensureAdminRequest(req, res))) return;
    
    const { key } = req.params;
    const { userId, profileId } = req.body;
    
    const result = removeFlagOverride(req.db, key, { userId, profileId });
    
    logAuditEvent(req.db, {
      category: AUDIT_CATEGORIES.ADMIN,
      action: 'feature_flag_override_remove',
      userId: req.user?.userId,
      resourceType: 'feature_flag',
      resourceId: key,
      details: { targetUserId: userId, targetProfileId: profileId },
    });
    
    res.json(result);
  } catch (error) {
    console.error('[admin/feature-flags/override/remove] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get flag overrides for a user/profile
 * GET /api/admin/feature-flags/overrides
 */
router.get('/feature-flags/overrides', async (req, res) => {
  try {
    if (!(await ensureAdminRequest(req, res))) return;
    
    const { userId, profileId } = req.query;
    const overrides = getFlagOverrides(req.db, {
      userId: userId || null,
      profileId: profileId || null,
    });
    
    res.json({ overrides });
  } catch (error) {
    console.error('[admin/feature-flags/overrides] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Cleanup expired flag overrides
 * POST /api/admin/feature-flags/cleanup
 */
router.post('/feature-flags/cleanup', async (req, res) => {
  try {
    if (!(await ensureAdminRequest(req, res))) return;
    
    const result = cleanupExpiredOverrides(req.db);
    
    res.json(result);
  } catch (error) {
    console.error('[admin/feature-flags/cleanup] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/admin/crawlers/audit-live
 * Admin-only: run each specialized crawler against each selected profile and report "why 0 results".
 *
 * Body:
 *  - profile_ids?: string[]
 *  - crawler_types?: string[] (defaults to all)
 *  - min_match_score?: number (data-point scale; defaults DEFAULT_MIN_SCORE)
 *  - timeout_ms?: number (defaults 20000)
 *  - limit_profiles?: number (defaults 25 when profile_ids not provided)
 *  - item_request?: string (used for item_matching)
 */
router.post('/crawlers/audit-live', async (req, res) => {
  try {
    if (!(await ensureAdminRequest(req, res))) return;

    const {
      profile_ids,
      crawler_types,
      // Data-point scale (pipeline bar ~8) — the old literal 50 was a
      // retired-scale fossil kept alive by the *0.25 conversion below.
      min_match_score = null,
      timeout_ms = 20000,
      limit_profiles = 25,
      item_request = null,
    } = req.body ?? {};

    // Bound the caller-supplied timeout on both ends: a floor so the audit
    // still means something, and a ceiling (2 min) so a very large or
    // malformed value can't wedge a timer/promise open for hours-to-days per
    // profile/crawler-type combination (resource exhaustion), even though
    // this route is already admin-only.
    const boundedTimeoutMs = Math.min(Math.max(1000, Number(timeout_ms) || 20000), 120_000);

    const types = Array.isArray(crawler_types) && crawler_types.length
      ? crawler_types.filter((t) => CRAWLER_AUDIT_TYPES.includes(t))
      : [...CRAWLER_AUDIT_TYPES];

    let profiles = [];
    if (Array.isArray(profile_ids) && profile_ids.length) {
      profiles = await req.db
        .prepare(`SELECT id, display_name, primary_type, status FROM profiles WHERE id IN (${profile_ids.map(() => '?').join(',')})`)
        .all(...profile_ids);
    } else {
      const lim = Math.max(1, Math.min(Number(limit_profiles) || 25, 200));
      profiles = await req.db
        .prepare(`SELECT id, display_name, primary_type, status FROM profiles WHERE status = 'active' ORDER BY updated_at DESC LIMIT ?`)
        .all(lim);
    }

    const auditStartedAt = Date.now();
    const results = [];

    for (const p of profiles) {
      const profileId = p.id;

      const profileRow = {
        profile_id: profileId,
        display_name: p.display_name,
        primary_type: p.primary_type,
        status: p.status,
        coverage: null,
        signals_summary: {},
        error: null,
        crawlers: [],
      };

      for (const crawlerType of types) {
        const startedAt = Date.now();
        let ok = true;
        let errorMessage = null;
        let opportunities = [];

        const hints = [];
        if (crawlerType === 'item_matching' && !item_request) hints.push('missing_item_request');

        try {
          if (crawlerType === 'item_matching') {
            const itemResult = await withTimeout(
              crawlItemFunding({ id: profileId }, { item_request }),
              boundedTimeoutMs,
              `audit:item_matching`,
            );
            opportunities = Array.isArray(itemResult) ? itemResult : [];
          } else {
            const curatedResult = await withTimeout(
              runCuratedCrawlerForAudit(req.db, profileId, {
                // min_match_score is on the CANONICAL data-point scale now; the
                // old (50-default * 0.25) dance converted retired-scale input.
                minScore: Math.max(
                  1,
                  Number.isFinite(Number(min_match_score)) && min_match_score !== null
                    ? Number(min_match_score)
                    : (await import('../config/matchThresholds.js')).DEFAULT_MIN_SCORE,
                ),
                maxResults: 100,
              }),
              boundedTimeoutMs,
              `audit:${crawlerType}`,
            );
            opportunities = Array.isArray(curatedResult?.results) ? curatedResult.results : [];
            profileRow.coverage = curatedResult?.analysis ? {
              state: curatedResult.analysis.location?.state,
              needs: [...(curatedResult.analysis.needs || [])],
            } : null;
          }
        } catch (error) {
          ok = false;
          errorMessage = error?.message || String(error);
        }

        const durationMs = Date.now() - startedAt;
        const count = opportunities.length;
        const sample = opportunities.slice(0, 3).map((o) => ({
          title: o?.title ?? null,
          url: o?.url ?? o?.application_url ?? o?.source_url ?? null,
          source: o?.source ?? null,
        }));

        profileRow.crawlers.push({
          crawler_type: crawlerType,
          ok,
          duration_ms: durationMs,
          count,
          hints,
          error: errorMessage,
          sample,
        });
      }

      results.push(profileRow);
    }

    const durationMs = Date.now() - auditStartedAt;

    // Also write a lightweight audit event (no PII/code leakage).
    try {
      logAuditEvent(req.db, {
        category: AUDIT_CATEGORIES.CRAWLER,
        severity: SEVERITY.INFO,
        message: 'Admin crawler live audit executed',
        details: {
          profiles: results.length,
          crawler_types: types,
          duration_ms: durationMs,
          at: nowIso(),
        },
        actor: req.user?.userId || req.user?.profileId || 'admin',
      });
    } catch {
      // ignore audit logging failures
    }

    return res.json({
      success: true,
      profiles: results.length,
      crawler_types: types,
      min_match_score,
      timeout_ms: boundedTimeoutMs,
      duration_ms: durationMs,
      results,
    });
  } catch (error) {
    console.error('[admin/crawlers/audit-live] Error:', error);
    return res.status(500).json({ success: false, error: error?.message || String(error) });
  }
});

/**
 * GET /api/admin/profiles/duplicates
 * Admin-only: list duplicate candidate profile groups (dry-run report).
 */
router.get('/profiles/duplicates', async (req, res, next) => {
  try {
    if (!(await ensureAdminRequest(req, res))) return

    const strategy = String(req.query?.strategy || 'exact_name')
    const limitGroups = Math.max(1, Math.min(Number(req.query?.limitGroups) || 50, 500))
    const minGroupSize = Math.max(2, Math.min(Number(req.query?.minGroupSize) || 2, 50))
    const includeInactive = String(req.query?.includeInactive || '').toLowerCase() === 'true'

    const report = await findDuplicateProfileGroups(req.db, { strategy, limitGroups, minGroupSize, includeInactive })

    return res.json({
      ok: true,
      strategy,
      limitGroups,
      minGroupSize,
      includeInactive,
      scanned: report.scanned ?? null,
      capped: report.capped ?? false,
      groups: report.groups,
    })
  } catch (error) {
    console.error('[admin/profiles/duplicates] Error:', error)
    return next(error)
  }
})

async function ensureProfileTombstonesTable(db) {
  const isPostgres = db?.dialect === 'postgres'
  await db.prepare(
    isPostgres
      ? `
        CREATE TABLE IF NOT EXISTS profile_tombstones (
          profile_id TEXT PRIMARY KEY,
          deleted_at TIMESTAMPTZ DEFAULT now(),
          deleted_by TEXT,
          reason TEXT
        )
      `
      : `
        CREATE TABLE IF NOT EXISTS profile_tombstones (
          profile_id TEXT PRIMARY KEY,
          deleted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          deleted_by TEXT,
          reason TEXT
        )
      `,
  ).run()
}

async function getProfileHardDeleteStats(db, profileId) {
  const pid = String(profileId || '').trim()
  const p = await db
    .prepare('SELECT id, display_name, primary_type, status, user_id, organization_id FROM profiles WHERE id = ? LIMIT 1')
    .get(pid)
  if (!p) return { ok: false, code: 'NOT_FOUND' }

  const sectionCount = Number(
    (await db.prepare('SELECT COUNT(*) AS count FROM profile_sections WHERE profile_id = ?').get(pid))?.count || 0,
  )
  const profileDocCount = Number(
    (await db.prepare('SELECT COUNT(*) AS count FROM profile_documents WHERE profile_id = ?').get(pid))?.count || 0,
  )
  const docCount = Number((await db.prepare('SELECT COUNT(*) AS count FROM documents WHERE profile_id = ?').get(pid))?.count || 0)
  const grantCount = Number((await db.prepare('SELECT COUNT(*) AS count FROM grants WHERE profile_id = ?').get(pid))?.count || 0)
  const jobCount = Number((await db.prepare('SELECT COUNT(*) AS count FROM crawler_jobs WHERE profile_id = ?').get(pid))?.count || 0)

  return {
    ok: true,
    profile: p,
    counts: {
      profile_sections: sectionCount,
      profile_documents: profileDocCount,
      documents: docCount,
      grants: grantCount,
      crawler_jobs: jobCount,
    },
  }
}

async function hardDeleteProfileById({ db, profileId, actorUserId, reason, tombstone = true }) {
  const pid = String(profileId || '').trim()
  if (!pid) throw new Error('profile id required')

  await ensureProfileTombstonesTable(db)

  // Best-effort delete helper (tolerate missing tables in drifted prod DBs).
  const safeRun = async (tx, sql, ...params) => {
    try {
      return await tx.prepare(sql).run(...params)
    } catch (error) {
      const msg = String(error?.message || error)
      if (msg.includes('no such table') || msg.includes('does not exist')) return null
      throw error
    }
  }

  await db.withTransaction(async (tx) => {
    if (tombstone) {
      await tx.prepare(
        `
          INSERT INTO profile_tombstones (profile_id, deleted_at, deleted_by, reason)
          VALUES (?, CURRENT_TIMESTAMP, ?, ?)
          ON CONFLICT(profile_id) DO UPDATE SET
            deleted_at = CURRENT_TIMESTAMP,
            deleted_by = excluded.deleted_by,
            reason = excluded.reason
        `,
      ).run(pid, actorUserId || null, reason || null)
    }

    // Delete dependent rows first (regardless of FK enforcement).
    await safeRun(tx, 'DELETE FROM profile_documents WHERE profile_id = ?', pid)
    await safeRun(tx, 'DELETE FROM documents WHERE profile_id = ?', pid)
    await safeRun(tx, 'DELETE FROM profile_sections WHERE profile_id = ?', pid)
    await safeRun(tx, 'DELETE FROM grants WHERE profile_id = ?', pid)
    await safeRun(tx, 'DELETE FROM crawler_jobs WHERE profile_id = ?', pid)
    await safeRun(tx, 'DELETE FROM billing_account_events WHERE account_id IN (SELECT id FROM billing_accounts WHERE profile_id = ?)', pid)
    await safeRun(tx, 'DELETE FROM billing_accounts WHERE profile_id = ?', pid)

    const out = await tx.prepare('DELETE FROM profiles WHERE id = ?').run(pid)
    const deletedCount = Number(out?.changes ?? out?.rowCount ?? 0)
    if (deletedCount <= 0) {
      const err = new Error('Profile was not deleted (not found)')
      err.code = 'NOT_FOUND'
      throw err
    }
  })
}

/**
 * POST /api/admin/profiles/:id/hard-delete
 * Admin-only: HARD delete an orphaned/deleted profile so it cannot return.
 *
 * Body:
 *  { reason?: string, tombstone?: boolean = true, force?: boolean = false }
 */
router.post('/profiles/:id/hard-delete', async (req, res) => {
  if (!(await ensureAdminRequest(req, res))) return

  const profileId = String(req.params.id || '').trim()
  if (!profileId) return res.status(400).json({ ok: false, error: 'profile id required' })

  const body = req.body ?? {}
  const tombstone = body.tombstone !== false
  const force = body.force === true
  const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : null

  if (isDesignatedProfileId(profileId) && !force) {
    return res.status(400).json({
      ok: false,
      error: 'Refusing to hard-delete a designated/system profile. Pass force=true to override.',
      code: 'DESIGNATED_PROFILE',
    })
  }

  const stats = await getProfileHardDeleteStats(req.db, profileId)
  if (!stats?.ok) return res.status(404).json({ ok: false, error: 'Profile not found' })

  const profile = stats.profile
  const counts = stats.counts
  const minSections = 2
  const isDeleted = String(profile?.status || '').toLowerCase() === 'deleted'
  const isUnowned = !profile?.user_id
  const hasNoContent =
    (Number(counts?.profile_sections || 0) < minSections) &&
    (Number(counts?.profile_documents || 0) === 0) &&
    (Number(counts?.documents || 0) === 0) &&
    (Number(counts?.grants || 0) === 0)

  // Safeguard: only hard-delete "truly orphaned" profiles unless force=true.
  if (!force) {
    if (!isDeleted) {
      return res.status(400).json({
        ok: false,
        error: "Profile must be deleted first (status='deleted') to hard-delete without force=true.",
        code: 'NOT_DELETED',
        profile_id: profileId,
      })
    }
    if (!isUnowned) {
      return res.status(400).json({
        ok: false,
        error: 'Profile has an owner (user_id). Pass force=true to override.',
        code: 'HAS_OWNER',
        profile_id: profileId,
      })
    }
    if (!hasNoContent) {
      return res.status(400).json({
        ok: false,
        error: 'Profile has meaningful linked data (sections/docs/pipeline). Pass force=true to override.',
        code: 'HAS_CONTENT',
        profile_id: profileId,
        counts,
      })
    }
  }

  await hardDeleteProfileById({
    db: req.db,
    profileId,
    actorUserId: req.ctx?.userId ?? req.user?.userId ?? null,
    reason,
    tombstone,
  })

  try {
    logAuditEvent(req.db, {
      category: AUDIT_CATEGORIES.ADMIN,
      action: 'profile_hard_delete',
      severity: SEVERITY.WARNING,
      userId: req.ctx?.userId ?? req.user?.userId ?? null,
      resourceType: 'profile',
      resourceId: profileId,
      details: { reason, tombstone, force, counts },
      ipAddress: req.ip || null,
      userAgent: req.headers['user-agent'] || null,
    })
  } catch {
    // ignore audit failures
  }

  return res.json({ ok: true, success: true, profile_id: profileId })
})

/**
 * GET /api/admin/profiles/orphans
 * Admin-only: list HARD-deletable orphan profiles (dry-run report).
 *
 * "Orphan" for hard delete means:
 * - status='deleted' (unless includeActive=true)
 * - user_id IS NULL (unless includeOwned=true)
 * - NOT a designated/system profile
 * - minimal content: <2 sections AND no docs AND no pipeline/grants
 */
router.get('/profiles/orphans', async (req, res) => {
  if (!(await ensureAdminRequest(req, res))) return

  const includeActive = String(req.query?.includeActive || '').toLowerCase() === 'true'
  const includeOwned = String(req.query?.includeOwned || '').toLowerCase() === 'true'
  const limit = Math.max(1, Math.min(Number(req.query?.limit) || 200, 2000))
  const offset = Math.max(0, Math.min(Number(req.query?.offset) || 0, 100_000))

  const whereDeleted = includeActive ? '' : "AND (p.status IS NOT NULL AND lower(p.status) = 'deleted')"
  const whereOwned = includeOwned ? '' : "AND (p.user_id IS NULL OR TRIM(p.user_id) = '')"

  const rows = await req.db
    .prepare(
      `
        SELECT
          p.id, p.display_name, p.primary_type, p.status, p.created_at, p.updated_at, p.user_id, p.organization_id,
          (SELECT COUNT(*) FROM profile_sections ps WHERE ps.profile_id = p.id) AS section_count,
          (SELECT COUNT(*) FROM profile_documents pd WHERE pd.profile_id = p.id) AS profile_document_count,
          (SELECT COUNT(*) FROM documents d WHERE d.profile_id = p.id) AS document_count,
          (SELECT COUNT(*) FROM grants g WHERE g.profile_id = p.id) AS grant_count
        FROM profiles p
        WHERE 1=1
          ${whereDeleted}
          ${whereOwned}
          AND (p.organization_id IS NULL OR TRIM(p.organization_id) = '')
          AND (SELECT COUNT(*) FROM profile_sections ps WHERE ps.profile_id = p.id) < 2
          AND (SELECT COUNT(*) FROM profile_documents pd WHERE pd.profile_id = p.id) = 0
          AND (SELECT COUNT(*) FROM documents d WHERE d.profile_id = p.id) = 0
          AND (SELECT COUNT(*) FROM grants g WHERE g.profile_id = p.id) = 0
        ORDER BY p.updated_at DESC
        LIMIT ? OFFSET ?
      `,
    )
    .all(limit, offset)

  const candidates = (rows || []).filter((r) => !isDesignatedProfileId(r?.id))

  return res.json({
    ok: true,
    includeActive,
    includeOwned,
    limit,
    offset,
    total_returned: candidates.length,
    candidates,
  })
})

/**
 * POST /api/admin/profiles/orphans/cleanup
 * Admin-only: HARD delete orphan profiles (default dry-run).
 *
 * Body:
 *  { dry_run?: boolean, limit?: number, tombstone?: boolean = true, reason?: string }
 */
async function handleOrphanProfilesHardDeleteCleanup(req, res) {
  if (!(await ensureAdminRequest(req, res))) return

  const dryRun = req.body?.dry_run !== false
  const limit = Math.max(1, Math.min(Number(req.body?.limit) || 200, 2000))
  const tombstone = req.body?.tombstone !== false
  const reason = typeof req.body?.reason === 'string' && req.body.reason.trim() ? req.body.reason.trim() : 'orphan_cleanup'

  const rows = await req.db
    .prepare(
      `
        SELECT
          p.id, p.display_name, p.primary_type, p.status, p.created_at, p.updated_at, p.user_id, p.organization_id,
          (SELECT COUNT(*) FROM profile_sections ps WHERE ps.profile_id = p.id) AS section_count,
          (SELECT COUNT(*) FROM profile_documents pd WHERE pd.profile_id = p.id) AS profile_document_count,
          (SELECT COUNT(*) FROM documents d WHERE d.profile_id = p.id) AS document_count,
          (SELECT COUNT(*) FROM grants g WHERE g.profile_id = p.id) AS grant_count
        FROM profiles p
        WHERE (p.status IS NOT NULL AND lower(p.status) = 'deleted')
          AND (p.user_id IS NULL OR TRIM(p.user_id) = '')
          AND (p.organization_id IS NULL OR TRIM(p.organization_id) = '')
          AND (SELECT COUNT(*) FROM profile_sections ps WHERE ps.profile_id = p.id) < 2
          AND (SELECT COUNT(*) FROM profile_documents pd WHERE pd.profile_id = p.id) = 0
          AND (SELECT COUNT(*) FROM documents d WHERE d.profile_id = p.id) = 0
          AND (SELECT COUNT(*) FROM grants g WHERE g.profile_id = p.id) = 0
        ORDER BY p.updated_at DESC
        LIMIT ?
      `,
    )
    .all(limit)

  const candidates = (rows || []).filter((r) => !isDesignatedProfileId(r?.id))
  const ids = candidates.map((c) => String(c.id))

  if (dryRun) {
    return res.json({
      ok: true,
      dry_run: true,
      would_delete: ids.length,
      candidates,
    })
  }

  let deleted = 0
  const deletedIds = []
  for (const id of ids) {
    await hardDeleteProfileById({
      db: req.db,
      profileId: id,
      actorUserId: req.ctx?.userId ?? req.user?.userId ?? null,
      reason,
      tombstone,
    })
    deleted += 1
    deletedIds.push(id)
  }

  try {
    logAuditEvent(req.db, {
      category: AUDIT_CATEGORIES.ADMIN,
      action: 'cleanup_orphan_profiles_hard_delete',
      severity: SEVERITY.WARNING,
      userId: req.ctx?.userId ?? req.user?.userId ?? null,
      resourceType: 'profile',
      resourceId: null,
      details: {
        deleted_count: deleted,
        profile_ids: deletedIds,
        tombstone,
        reason,
      },
      ipAddress: req.ip || null,
      userAgent: req.headers['user-agent'] || null,
    })
  } catch {
    // ignore audit failures
  }

  return res.json({
    ok: true,
    dry_run: false,
    deleted,
    deleted_ids: deletedIds,
  })
}

router.post('/profiles/orphans/cleanup', async (req, res) => {
  return handleOrphanProfilesHardDeleteCleanup(req, res)
})

/**
 * POST /api/admin/cleanup/orphan-profiles
 * Alias for /api/admin/profiles/orphans/cleanup (hard-delete).
 */
router.post('/cleanup/orphan-profiles', async (req, res) => {
  return handleOrphanProfilesHardDeleteCleanup(req, res)
})

/**
 * POST /api/admin/profiles/:id/restore-access
 * Admin-only: repair ownership/sharing for an existing profile.
 *
 * Body:
 *  { user_id?: string, add_emails?: string[], set_basic_email?: string, restore_deleted?: boolean }
 */
router.post('/profiles/:id/restore-access', async (req, res) => {
  if (!(await ensureAdminRequest(req, res))) return

  const profileId = String(req.params.id || '').trim()
  if (!profileId) return res.status(400).json({ ok: false, error: 'profile id required' })

  const body = req.body ?? {}
  const requestedUserId = typeof body.user_id === 'string' && body.user_id.trim() ? String(body.user_id).trim() : null
  const restoreDeleted = body.restore_deleted === true

  const rawEmails = Array.isArray(body.add_emails) ? body.add_emails : body.add_emails ? [body.add_emails] : []
  const addEmails = rawEmails.map((e) => normalizeEmail(e)).filter(Boolean)

  const setBasicEmail = normalizeEmail(body.set_basic_email)

  const existing = await req.db
    .prepare('SELECT id, user_id, organization_id, status FROM profiles WHERE id = ? LIMIT 1')
    .get(profileId)
  if (!existing) return res.status(404).json({ ok: false, error: 'Profile not found' })

  if (String(existing.status || '').toLowerCase() === 'deleted' && !restoreDeleted) {
    return res.status(409).json({
      ok: false,
      error: 'Profile is deleted. Pass restore_deleted=true to restore it.',
      code: 'PROFILE_DELETED',
    })
  }

  // If caller didn't provide emails, try to self-heal from organizations.email.
  let derivedEmail = null
  try {
    if ((!addEmails || addEmails.length === 0) && existing.organization_id) {
      const org = await req.db.prepare('SELECT email FROM organizations WHERE id = ? LIMIT 1').get(String(existing.organization_id))
      derivedEmail = normalizeEmail(org?.email)
    }
  } catch {
    derivedEmail = null
  }

  const emailsToAdd = Array.from(new Set([...(addEmails || []), ...(derivedEmail ? [derivedEmail] : [])]))

  const changes = {}

  if (restoreDeleted) {
    changes.status = null
  }
  if (requestedUserId !== null) {
    changes.user_id = requestedUserId
  }

  // Apply DB changes
  if (Object.keys(changes).length > 0) {
    const setCols = []
    const params = []
    const allowedProfileRepairColumns = {
      status: 'status',
      user_id: 'user_id',
    }
    for (const [k, v] of Object.entries(changes)) {
      const safeColumn = allowedProfileRepairColumns[k]
      if (!safeColumn) {
        return res.status(400).json({ ok: false, error: `Unsupported profile repair column: ${k}` })
      }
      setCols.push(`${safeColumn} = ?`)
      params.push(v)
    }
    setCols.push('updated_at = CURRENT_TIMESTAMP')
    const safeSetClause = setCols.join(', ')
    await req.db.prepare(`UPDATE profiles SET ${safeSetClause} WHERE id = ?`).run(...params, profileId)
  }

  let addedCount = 0
  if (emailsToAdd.length > 0) {
    const added = await addProfileEmails(req.db, {
      profileId,
      emails: emailsToAdd,
      addedBy: req.ctx?.userId ?? req.user?.userId ?? 'admin',
    })
    addedCount = Number(added?.added || 0)
  }

  // Upsert basic_information.email if requested
  let basicUpdated = false
  if (setBasicEmail) {
    try {
      const section = await req.db
        .prepare(`SELECT id, data FROM profile_sections WHERE profile_id = ? AND section_key = 'basic_information' LIMIT 1`)
        .get(profileId)
      let data = {}
      if (section?.data) {
        try {
          data = typeof section.data === 'string' ? JSON.parse(section.data) : section.data
        } catch {
          data = {}
        }
      }
      const next = { ...(data && typeof data === 'object' ? data : {}), email: setBasicEmail }
      const id = section?.id || crypto.randomUUID()
      await req.db
        .prepare(
          `
            INSERT INTO profile_sections (id, profile_id, section_key, data, updated_by)
            VALUES (?, ?, 'basic_information', ?, ?)
            ON CONFLICT(profile_id, section_key) DO UPDATE SET
              data = excluded.data,
              updated_at = CURRENT_TIMESTAMP,
              updated_by = excluded.updated_by
          `,
        )
        .run(id, profileId, JSON.stringify(next), req.ctx?.userId ?? 'admin')
      basicUpdated = true
    } catch {
      basicUpdated = false
    }
  }

  const updated = await req.db.prepare('SELECT * FROM profiles WHERE id = ? LIMIT 1').get(profileId)
  const emails = await listProfileEmails(req.db, profileId).catch(() => [])

  // Durable audit log
  try {
    logAuditEvent(req.db, {
      category: AUDIT_CATEGORIES.ADMIN,
      action: 'profile_restore_access',
      severity: SEVERITY.INFO,
      userId: req.ctx?.userId ?? req.user?.userId ?? null,
      profileId,
      resourceType: 'profile',
      resourceId: profileId,
      details: {
        requested_user_id: requestedUserId,
        restore_deleted: restoreDeleted,
        added_emails: emailsToAdd,
        added_count: addedCount,
        set_basic_email: setBasicEmail ? true : false,
        basic_updated: basicUpdated,
      },
      ipAddress: req.ip || null,
      userAgent: req.headers['user-agent'] || null,
    })
  } catch {
    // ignore audit failures
  }

  return res.json({
    ok: true,
    profile: updated,
    emails,
    changes: {
      updated_user_id: requestedUserId !== null,
      restored_deleted: restoreDeleted,
      added_emails: addedCount,
      basic_email_updated: basicUpdated,
    },
  })
})

/**
 * POST /api/admin/profiles/restore-sections-from-orgs
 * Fills empty profile_sections from linked organizations rows (does not wipe user edits).
 *
 * Body: { dryRun?: boolean, limit?: number, organizationIds?: string[], profileIds?: string[] }
 */
router.post('/profiles/restore-sections-from-orgs', async (req, res) => {
  try {
    const body = req.body ?? {}
    const result = await restoreProfileSectionsFromLinkedOrganizations(req.db, {
      dryRun: body.dryRun === true,
      limit: body.limit,
      organizationIds: Array.isArray(body.organizationIds) ? body.organizationIds : undefined,
      profileIds: Array.isArray(body.profileIds) ? body.profileIds : undefined,
    })
    return res.json(result)
  } catch (error) {
    routeLogger.error('[admin/profiles/restore-sections-from-orgs]', error)
    return res.status(500).json({ ok: false, error: error?.message || String(error) })
  }
})

/**
 * POST /api/admin/profiles/merge
 * Admin-only: merge one or more "loser" profiles into a "winner" profile.
 */
router.post('/profiles/merge', async (req, res, next) => {
  try {
    if (!(await ensureAdminRequest(req, res))) return

    const winnerId = typeof req.body?.winnerId === 'string' ? req.body.winnerId : null
    const loserIds = Array.isArray(req.body?.loserIds) ? req.body.loserIds : null
    const dryRun = coerceDryRun(req.body?.dryRun, true)

    if (!winnerId || !loserIds || loserIds.length === 0) {
      return res.status(400).json({
        ok: false,
        error: 'winnerId (string) and loserIds (non-empty array) are required',
        error_type: 'invalid_input',
      })
    }

    const result = await mergeProfiles(req.db, {
      winnerId,
      loserIds,
      dryRun,
      actorUserId: req.ctx?.userId ?? req.user?.userId ?? null,
    })

    return res.json({ ok: true, ...result })
  } catch (error) {
    routeLogger.error('[admin/profiles/merge] Error:', error)
    return res.status(500).json({
      ok: false,
      error: error?.message || String(error),
      error_type: 'merge_failed',
    })
  }
})

function normalizeEmail(value) {
  const email = String(value ?? '').trim().toLowerCase()
  if (!email || !email.includes('@')) return null
  return email
}

async function loadProfileEmailSignals(db, profileIds) {
  const ids = Array.from(new Set((profileIds || []).filter(Boolean).map(String)))
  const byProfile = new Map(ids.map((id) => [id, new Set()]))
  if (ids.length === 0) return byProfile

  const placeholders = ids.map(() => '?').join(', ')
  const sectionRows = await db
    .prepare(
      `
        SELECT profile_id, data
        FROM profile_sections
        WHERE profile_id IN (${placeholders})
      `,
    )
    .all(...ids)

  for (const row of sectionRows || []) {
    const pid = String(row.profile_id || '')
    if (!pid || !byProfile.has(pid)) continue
    let obj = null
    try {
      obj = JSON.parse(row.data)
    } catch {
      obj = null
    }
    if (!obj || typeof obj !== 'object') continue
    const candidates = [
      obj.email,
      obj.primary_email,
      obj.contact_email,
      obj.contactEmail,
    ]
    for (const c of candidates) {
      const e = normalizeEmail(c)
      if (e) byProfile.get(pid).add(e)
    }
  }

  // Also include profile_emails if the table exists (best-effort).
  try {
    const emailRows = await db
      .prepare(
        `
          SELECT profile_id, email
          FROM profile_emails
          WHERE profile_id IN (${placeholders})
        `,
      )
      .all(...ids)
    for (const row of emailRows || []) {
      const pid = String(row.profile_id || '')
      if (!pid || !byProfile.has(pid)) continue
      const e = normalizeEmail(row.email)
      if (e) byProfile.get(pid).add(e)
    }
  } catch {
    // ignore missing table/schema
  }

  return byProfile
}


/**
 * POST /api/admin/profiles/deduplicate
 * Admin-only: merge ALL duplicate groups using a deterministic winner selection:
 * - keep the profile owned by a non-admin user whose primary_email matches the profile email
 * - otherwise keep the best non-admin-owned profile
 * - otherwise keep the most complete profile
 */
router.post('/profiles/deduplicate', async (req, res) => {
  try {
    if (!(await ensureAdminRequest(req, res))) return

    const strategy = String(req.body?.strategy || req.query?.strategy || 'similar_name')
    const strategies = Array.isArray(req.body?.strategies)
      ? req.body.strategies.map((s) => String(s || '').trim()).filter(Boolean)
      : [strategy]
    const includeInactive = String(req.body?.includeInactive || req.query?.includeInactive || '').toLowerCase() === 'true'
    const limitGroups = Math.max(1, Math.min(Number(req.body?.limitGroups ?? req.query?.limitGroups) || 500, 2000))
    const minGroupSize = Math.max(2, Math.min(Number(req.body?.minGroupSize ?? req.query?.minGroupSize) || 2, 50))
    const dryRun = coerceDryRun(req.body?.dryRun, false)

    const actorUserId = req.ctx?.userId ?? req.user?.userId ?? null
    const deduped = await deduplicateProfileGroups(req.db, {
      strategies,
      limitGroups,
      minGroupSize,
      includeInactive,
      dryRun,
      actorUserId,
    })

    return res.json({
      ok: true,
      strategy,
      strategies: deduped.strategies,
      includeInactive,
      limitGroups,
      minGroupSize,
      dryRun,
      merged_groups: deduped.merged_groups,
      results: deduped.results,
    })
  } catch (error) {
    routeLogger.error('[admin/profiles/deduplicate] Error:', error)
    return res.status(500).json({
      ok: false,
      error: error?.message || String(error),
      error_type: 'dedupe_failed',
    })
  }
})

// Dead Letter Queue Management
router.get('/dead-letter-queue', async (req, res) => {
  try {
    if (!(await ensureAdminRequest(req, res))) return
    const { getUnresolvedFailures, getFailureStatistics } = await import('../services/deadLetterQueue.js');
    const { jobType, limit = 100 } = req.query;
    
    if (jobType) {
      const failures = await getUnresolvedFailures(req.db, jobType, parseInt(limit, 10));
      res.json({ failures, count: failures.length });
    } else {
      const stats = await getFailureStatistics(req.db);
      res.json({ statistics: stats });
    }
  } catch (error) {
    console.error('[admin] Error fetching dead letter queue:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/dead-letter-queue/:id/resolve', async (req, res) => {
  try {
    if (!(await ensureAdminRequest(req, res))) return
    const { resolveFailure } = await import('../services/deadLetterQueue.js');
    const { id } = req.params;
    const { notes } = req.body;
    const userId = req.user?.userId || req.user?.id || 'system';
    
    await resolveFailure(req.db, id, userId, notes);
    res.json({ success: true, message: 'Dead letter entry resolved' });
  } catch (error) {
    console.error('[admin] Error resolving dead letter entry:', error);
    res.status(500).json({ error: error.message });
  }
});
/**
 * POST /api/admin/clear-all-pipelines
 * Deletes all grants (pipeline items), related milestones, pipeline events,
 * application drafts, vnext applications, crawler jobs, and crawl results.
 * Funding opportunities are preserved so re-crawling can repopulate.
 */
router.post('/clear-all-pipelines', async (req, res) => {
  try {
    if (!(await ensureAdminRequest(req, res))) return

    const db = req.db
    const results = {}

    const safeDelete = async (label, sql, ...params) => {
      try {
        const r = await db.prepare(sql).run(...params)
        results[label] = r?.changes ?? 0
      } catch (e) {
        results[label] = `error: ${e.message}`
      }
    }

    // Order matters: delete children before parents (FK constraints)
    await safeDelete('grant_pipeline_events', 'DELETE FROM grant_pipeline_events')
    await safeDelete('grant_monitoring_logs', 'DELETE FROM grant_monitoring_logs')
    await safeDelete('grant_monitoring_alerts', 'DELETE FROM grant_monitoring_alerts')
    await safeDelete('milestones', 'DELETE FROM milestones')
    await safeDelete('application_drafts', 'DELETE FROM application_drafts')
    await safeDelete('budgets', 'DELETE FROM budgets')
    await safeDelete('expenses', 'DELETE FROM expenses')
    await safeDelete('ai_artifacts', 'DELETE FROM ai_artifacts')
    await safeDelete('vnext_application_tasks', 'DELETE FROM vnext_application_tasks')
    await safeDelete('vnext_applications', 'DELETE FROM vnext_applications')
    await safeDelete('grants', 'DELETE FROM grants')
    await safeDelete('crawl_results', 'DELETE FROM crawl_results')
    await safeDelete('crawl_metadata', 'DELETE FROM crawl_metadata')
    await safeDelete('crawler_jobs', 'DELETE FROM crawler_jobs')

    routeLogger.info('[admin] clear-all-pipelines completed:', results)
    res.json({
      success: true,
      message: 'All pipelines cleared. Funding opportunities preserved for re-crawling.',
      deleted: results,
    })
  } catch (error) {
    routeLogger.error('[admin] clear-all-pipelines error:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * POST /api/admin/clean-pipelines-against-goals
 *
 * Audit every profile's pipeline (the `grants` table) against the
 * GrantFlow mission goals and remove items that fail the canonical
 * "real funding only / matches actual needs" checks while keeping
 * directory-style resources, items with usable URLs, and items the
 * matcher accepts or sends to REVIEW.
 *
 * Removal verdicts (Goal numbers in parens):
 *   - source_disallowed (Goal 1)
 *   - dead_url          (Goals 1 + 7)
 *   - duplicate_title   (Goal 9)
 *   - wrong_state       (Goal 6)
 *   - relevance_reject  (Goals 2 + 4)
 *
 * Body (all optional):
 *   {
 *     dry_run?: boolean = true   // when false, actually deletes
 *   }
 *
 * Response:
 *   {
 *     success: true,
 *     dry_run: boolean,
 *     total_grants, profiles_with_pipeline, removed, kept,
 *     verdict_totals: { keep, source_disallowed, dead_url, ... },
 *     per_profile: [
 *       { profile_id, display_name, primary_type, profile_state,
 *         total, verdicts, removed_items: [{ id, title, verdict, reason, ruleId }] }
 *     ]
 *   }
 */
router.post('/clean-pipelines-against-goals', async (req, res) => {
  try {
    if (!(await ensureAdminRequest(req, res))) return

    const dryRun = req.body?.dry_run !== false

    const report = await auditPipelinesAgainstGoals(req.db, { dryRun })

    routeLogger.info(
      `[admin] clean-pipelines-against-goals (${dryRun ? 'DRY RUN' : 'LIVE'}): ` +
        `audited=${report.total_grants}, removed=${report.removed}, kept=${report.kept}, ` +
        `profiles=${report.profiles_with_pipeline}`,
    )

    if (!dryRun) {
      try {
        logAuditEvent(req.db, {
          category: AUDIT_CATEGORIES.ADMIN,
          action: 'clean_pipelines_against_goals',
          severity: SEVERITY.WARNING,
          userId: req.ctx?.userId ?? req.user?.userId ?? null,
          details: {
            removed: report.removed,
            kept: report.kept,
            verdict_totals: report.verdict_totals,
          },
        })
      } catch {
        // Audit log failure is non-fatal
      }
    }

    res.json({ success: true, ...report })
  } catch (error) {
    routeLogger.error('[admin] clean-pipelines-against-goals error:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * POST /api/admin/backfill-matches
 * Re-evaluates all existing profile pipeline entries using the current decision engine.
 * Updates match_decision, match_explanation, matched_needs, eligibility_status,
 * ineligibility_reasons, profile_fingerprint, opportunity_fingerprint, matcher_version, evaluated_at.
 * Removes entries that are now hard-ineligible (REJECT).
 */
router.post('/backfill-matches', async (req, res) => {
  try {
    if (!(await ensureAdminRequest(req, res))) return

    const db = req.db

    // Check that migration columns exist
    let hasDecisionColumns = false
    try {
      const dialect = db?.dialect || 'sqlite'
      if (dialect === 'postgres') {
        const row = await db
          .prepare(
            `SELECT 1 AS ok FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = ? AND column_name = ? LIMIT 1`,
          )
          .get('grants', 'match_decision')
        hasDecisionColumns = Boolean(row?.ok)
      } else {
        const cols = await db.prepare('PRAGMA table_info(grants)').all()
        hasDecisionColumns = cols.some((c) => c.name === 'match_decision')
      }
    } catch { /* ignore */ }

    if (!hasDecisionColumns) {
      return res.status(400).json({
        error: 'Decision columns not found in grants table. Run `npm run migrate` first.',
      })
    }

    const { computeMatchDecision, normalizeProfile, computeProfileFingerprint, normalizeOpportunity, computeOpportunityFingerprint, MATCHER_VERSION } = await import('../services/matchEngine.js')

    // Load all pipeline entries with associated opportunity and profile data
    const grants = await db
      .prepare(
        `SELECT g.id, g.profile_id, g.funding_opportunity_id, g.title,
                fo.description, fo.sponsor, fo.eligibility_bullets, fo.categories,
                fo.keywords, fo.is_national, fo.state, fo.application_url,
                fo.source_url, fo.record_origin, fo.is_loan, fo.deadline,
                fo.deadline_type, fo.funding_type, fo.opportunity_type,
                fo.entity_types_allowed, fo.need_types_supported,
                p.primary_type, p.tags
         FROM grants g
         LEFT JOIN funding_opportunities fo ON fo.id = g.funding_opportunity_id
         LEFT JOIN profiles p ON p.id = g.profile_id
         WHERE g.profile_id IS NOT NULL`,
      )
      .all()

    // Fetch profile sections separately to avoid SQLite-only json_group_object aggregate
    const sectionRows = await db
      .prepare(
        `SELECT profile_id, section_key, data FROM profile_sections
         WHERE profile_id IN (SELECT DISTINCT profile_id FROM grants WHERE profile_id IS NOT NULL)`,
      )
      .all()
    const profileSectionsMap = new Map()
    for (const r of sectionRows) {
      if (!profileSectionsMap.has(r.profile_id)) profileSectionsMap.set(r.profile_id, {})
      try {
        profileSectionsMap.get(r.profile_id)[r.section_key] = JSON.parse(r.data)
      } catch {
        console.warn(`[admin/backfill-matches] Failed to parse section data for profile ${r.profile_id}, key ${r.section_key}`)
        profileSectionsMap.get(r.profile_id)[r.section_key] = r.data
      }
    }

    let accepted = 0
    let reviewed = 0
    let rejected = 0
    let errors = 0

    for (const row of grants) {
      try {
        const rawProfile = {
          id: row.profile_id,
          primary_type: row.primary_type,
          tags: row.tags,
        }
        let sections = profileSectionsMap.get(row.profile_id) ?? null

        const rawOpp = {
          id: row.funding_opportunity_id,
          title: row.title,
          description: row.description,
          sponsor: row.sponsor,
          eligibility_bullets: row.eligibility_bullets,
          categories: row.categories,
          keywords: row.keywords,
          is_national: row.is_national,
          state: row.state,
          application_url: row.application_url,
          source_url: row.source_url,
          record_origin: row.record_origin,
          is_loan: row.is_loan,
          deadline: row.deadline,
          deadline_type: row.deadline_type,
          funding_type: row.funding_type,
          opportunity_type: row.opportunity_type,
          entity_types_allowed: row.entity_types_allowed,
          need_types_supported: row.need_types_supported,
        }

        const decision = computeMatchDecision(rawProfile, rawOpp, { profileSections: sections })
        const profileFingerprint = computeProfileFingerprint(normalizeProfile(rawProfile, sections))
        const opportunityFingerprint = computeOpportunityFingerprint(normalizeOpportunity(rawOpp))

        if (decision.decision === 'REJECT') {
          // Remove hard-ineligible entries
          await db.prepare('DELETE FROM grants WHERE id = ? AND profile_id = ?').run(row.id, row.profile_id)
          rejected++
        } else {
          // Update metadata
          await db.prepare(`
            UPDATE grants SET
              match_decision = ?,
              match_explanation = ?,
              matched_needs = ?,
              eligibility_status = ?,
              ineligibility_reasons = ?,
              profile_fingerprint = ?,
              opportunity_fingerprint = ?,
              matcher_version = ?,
              evaluated_at = ?,
              match_confidence = ?,
              match_score = ?
            WHERE id = ? AND profile_id = ?
          `).run(
            decision.decision,
            decision.explanation,
            JSON.stringify(decision.matchedNeeds),
            String(decision.eligible),
            JSON.stringify(decision.ineligibilityReasons),
            profileFingerprint,
            opportunityFingerprint,
            MATCHER_VERSION,
            new Date().toISOString(),
            decision.confidence,
            decision.score,
            row.id,
            row.profile_id,
          )
          if (decision.decision === 'ACCEPT') accepted++
          else reviewed++
        }
      } catch (err) {
        console.error(`[admin/backfill-matches] Error processing grant ${row.id}:`, err)
        errors++
      }
    }

    routeLogger.info(`[admin/backfill-matches] Completed: accepted=${accepted}, reviewed=${reviewed}, rejected=${rejected}, errors=${errors}`)

    res.json({
      success: true,
      total: grants.length,
      accepted,
      reviewed,
      rejected,
      errors,
      matcherVersion: MATCHER_VERSION,
    })
  } catch (error) {
    routeLogger.error('[admin/backfill-matches] error:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * POST /api/admin/purge/regional/run
 * Trigger the regional purge for discovered or specified states.
 *
 * Body (all optional):
 *   dry_run                  boolean  – if true, no DB mutations (default: false)
 *   states                   string[] – explicit states; auto-discovered if omitted
 *   limit                    number   – max opps to check (default 500)
 *   onlySuppressedCandidates boolean  – only re-check watch/suppressed items
 */
router.post('/purge/regional/run', async (req, res) => {
  if (!(await ensureAdminRequest(req, res))) return
  try {
    const {
      dry_run: dryRun = false,
      states,
      limit = 500,
      onlySuppressedCandidates = false,
    } = req.body || {}

    const result = await runRegionalPurge(req.db, {
      dryRun: Boolean(dryRun),
      states: Array.isArray(states) && states.length > 0 ? states : undefined,
      limit: Math.min(Number(limit) || 500, 5000),
      onlySuppressedCandidates: Boolean(onlySuppressedCandidates),
    })

    res.json({ ok: true, dryRun: Boolean(dryRun), ...result })
  } catch (err) {
    routeLogger.error('[admin/purge/regional/run] Error:', err)
    res.status(500).json({ error: err?.message || 'Purge failed' })
  }
})

/**
 * GET /api/admin/purge/regional/summary
 * Returns recent suppression event totals and the 20 most recent events.
 */
router.get('/purge/regional/summary', async (req, res) => {
  if (!(await ensureAdminRequest(req, res))) return
  try {
    const summary = await getPurgeSummary(req.db)
    res.json({ ok: true, ...summary })
  } catch (err) {
    routeLogger.error('[admin/purge/regional/summary] Error:', err)
    res.status(500).json({ error: err?.message })
  }
})

/**
 * GET /api/admin/purge/regional/events
 * Paginated event log.
 *
 * Query params:
 *   page     number  – 1-based page number (default 1)
 *   pageSize number  – rows per page (default 50, max 200)
 *   state    string  – optional 2-letter state filter
 */
router.get('/purge/regional/events', async (req, res) => {
  if (!(await ensureAdminRequest(req, res))) return
  try {
    const page = Math.max(1, Number(req.query.page) || 1)
    const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 50))
    const state = req.query.state ? String(req.query.state).toUpperCase() : undefined
    const result = await getPurgeEvents(req.db, { page, pageSize, state })
    res.json({ ok: true, ...result })
  } catch (err) {
    routeLogger.error('[admin/purge/regional/events] Error:', err)
    res.status(500).json({ error: err?.message })
  }
})

/**
 * GET /api/admin/anya-health
 * Returns the most recent Anya health check status.
 */
router.get('/anya-health', async (req, res) => {
  if (!(await ensureAdminRequest(req, res))) return
  const status = getLastHealthStatus()
  if (!status) {
    return res.json({ status: 'no_check_run', message: 'No health check has run yet. Use POST /api/admin/anya-health/run to trigger one.' })
  }
  res.json(status)
})

/**
 * POST /api/admin/anya-health/run
 * Triggers an immediate Anya health check and returns the result.
 */
router.post('/anya-health/run', async (req, res) => {
  if (!(await ensureAdminRequest(req, res))) return
  try {
    const result = await runHealthCheck(req.db)
    res.json(result)
  } catch (err) {
    routeLogger.error('[admin/anya-health/run] Error:', err)
    res.status(500).json({ error: err.message })
  }
})

/**
 * GET /api/admin/anya-repair
 * Dry-run scan — returns a report without modifying any files.
 */
router.get('/anya-repair', async (req, res) => {
  if (!(await ensureAdminRequest(req, res))) return
  try {
    const report = await runAutoRepair(req.db, { dryRun: true })
    res.json(report)
  } catch (err) {
    routeLogger.error('[admin/anya-repair] Error:', err)
    res.status(500).json({ error: err.message })
  }
})

/**
 * POST /api/admin/anya-repair/run
 * Apply repairs. Accepts optional `repairTypes` array in request body.
 */
router.post('/anya-repair/run', async (req, res) => {
  if (!(await ensureAdminRequest(req, res))) return
  try {
    const { repairTypes } = req.body || {}
    const report = await runAutoRepair(req.db, { dryRun: false, repairTypes })
    res.json(report)
  } catch (err) {
    routeLogger.error('[admin/anya-repair/run] Error:', err)
    res.status(500).json({ error: err.message })
  }
})

/**
 * GET /api/admin/exclusion-rules
 * Returns all configured exclusion rules.
 */
router.get('/exclusion-rules', async (req, res) => {
  try {
    const rules = await req.db.prepare(`SELECT * FROM exclusion_rules`).all()
    res.json({ rules })
  } catch (err) {
    routeLogger.error('[admin/exclusion-rules] Error:', err)
    res.status(500).json({ error: err.message })
  }
})

/**
 * POST /api/admin/exclusion-rules
 * Create or replace an exclusion rule.
 */
router.post('/exclusion-rules', async (req, res) => {
  try {
    const { rule_id, pattern, action } = req.body
    if (!pattern) {
      return res.status(400).json({ error: 'pattern is required' })
    }
    const id = rule_id || `rule_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const act = action || 'hide'

    // Dialect-portable upsert. `INSERT OR REPLACE` is SQLite-only and the
    // Postgres adapter does not rewrite it, so branch on the active dialect.
    const upsertSql = req.db.dialect === 'postgres'
      ? `INSERT INTO exclusion_rules (rule_id, pattern, action)
         VALUES (?, ?, ?)
         ON CONFLICT (rule_id) DO UPDATE
           SET pattern = EXCLUDED.pattern, action = EXCLUDED.action`
      : `INSERT OR REPLACE INTO exclusion_rules (rule_id, pattern, action)
         VALUES (?, ?, ?)`

    await req.db.prepare(upsertSql).run(id, pattern, act)

    res.json({ success: true, rule_id: id })
  } catch (err) {
    routeLogger.error('[admin/exclusion-rules] Error:', err)
    res.status(500).json({ error: err.message })
  }
})

/**
 * DELETE /api/admin/exclusion-rules/:ruleId
 * Remove an exclusion rule by its ID.
 */
router.delete('/exclusion-rules/:ruleId', async (req, res) => {
  try {
    const { ruleId } = req.params
    if (!ruleId) {
      return res.status(400).json({ error: 'ruleId is required' })
    }
    const result = await req.db.prepare(
      `DELETE FROM exclusion_rules WHERE rule_id = ?`
    ).run(ruleId)
    const deleted = result?.changes ?? result?.rowCount ?? 0
    if (deleted === 0) {
      return res.status(404).json({ error: 'Rule not found' })
    }
    res.json({ success: true, deleted })
  } catch (err) {
    routeLogger.error('[admin/exclusion-rules] Delete error:', err)
    res.status(500).json({ error: err.message })
  }
})

/**
 * POST /api/admin/verify-links
 * Triggers a background link verification pass on funding_opportunities.
 * Checks up to 200 URLs that haven't been verified in the last 30 days.
 */
router.post('/verify-links', async (req, res) => {
  try {
    if (!(await ensureAdminRequest(req, res))) return
    const { runLinkVerification } = await import('../services/linkVerificationService.js')
    const stats = await runLinkVerification(req.db, { limit: 200 })
    res.json({ success: true, stats })
  } catch (err) {
    routeLogger.error('[admin/verify-links] Error:', err)
    res.status(500).json({ success: false, error: err.message })
  }
})

/**
 * POST /api/admin/crawler-jobs/resolve-failures
 * Deletes historical failed crawler_jobs older than 1 hour so they stop polluting health metrics.
 * Safe to call after root causes are fixed — these records are diagnostic, not referential.
 */
router.post('/crawler-jobs/resolve-failures', async (req, res) => {
  try {
    if (!(await ensureAdminRequest(req, res))) return
    const sql = req.db.dialect === 'postgres'
      ? `DELETE FROM crawler_jobs WHERE status = 'failed' AND created_at < (NOW() - INTERVAL '1 hour')`
      : `DELETE FROM crawler_jobs WHERE status = 'failed' AND created_at < datetime('now', '-1 hour')`

    const result = await req.db.prepare(sql).run()
    const deleted = result?.rowCount ?? result?.changes ?? 0
    routeLogger.info(`[admin] Deleted ${deleted} stale failed crawler job(s)`)
    res.json({ success: true, deleted })
  } catch (err) {
    routeLogger.error('[admin/resolve-failures] Error:', err)
    res.status(500).json({ success: false, error: err.message })
  }
})

/**
 * POST /api/admin/anya/runAutonomous
 *
 * Direct admin entrypoint for the autonomous code audit engine. Equivalent to
 * POST /api/anya/autonomous/code, but returns the {id, tool, output} envelope
 * shape used by the Anya tool adapter. Protected by the router-level
 * ensureAuth + ensureAdmin guards above.
 *
 * Body (all optional):
 *   { directory, pattern, dry_run, max_iterations, max_file_changes,
 *     fixConsoleLog, fixEmptyCatch, fixTodos }
 *
 * Writes require dry_run === false. Production additionally requires
 * ANYA_CODE_REPAIR_PRODUCTION_WRITES=true. All scans remain confined to the
 * server-owned repository root; each write is backed up and audited.
 */
router.post('/anya/runAutonomous', async (req, res) => {
  const {
    directory = '',
    pattern = null,
    dry_run = true,
    max_iterations,
    max_file_changes,
    fixConsoleLog,
    fixEmptyCatch,
    fixTodos,
  } = req.body || {}

  const production = [process.env.NODE_ENV, process.env.DEPLOY_ENV]
    .some((value) => String(value || '').toLowerCase() === 'production')
  if (dry_run === false && production && process.env.ANYA_CODE_REPAIR_PRODUCTION_WRITES !== 'true') {
    return res.status(403).json({
      id: crypto.randomUUID(),
      tool: 'admin.anya.runAutonomous',
      output: {
        success: false,
        code: 'ANYA_PRODUCTION_WRITES_DISABLED',
        error: 'Production code repair writes are disabled. Run dry_run=true or enable the explicit operator gate.',
      },
    })
  }

  const options = {
    directory,
    pattern,
    dryRun: Boolean(dry_run),
    // dry_run=false in HTTP is the per-invocation write signal.
    writeFlag: dry_run === false,
    maxIterations: Number.isFinite(Number(max_iterations)) ? Number(max_iterations) : undefined,
    maxFileChanges: Number.isFinite(Number(max_file_changes)) ? Number(max_file_changes) : undefined,
  }
  if (typeof fixConsoleLog === 'boolean') options.fixConsoleLog = fixConsoleLog
  if (typeof fixEmptyCatch === 'boolean') options.fixEmptyCatch = fixEmptyCatch
  if (typeof fixTodos === 'boolean') options.fixTodos = fixTodos

  const context = {
    db: req.db,
    user: req.ctx?.user ?? req.user ?? null,
    req,
    // Server-owned injection for clean-room/test installations. Never read
    // this authority from the request body.
    trustedRepoRoot: req.app?.locals?.trustedRepoRoot || undefined,
  }

  try {
    const output = await runAutonomousCodeCrawl(options, context)
    return res.status(200).json({
      id: crypto.randomUUID(),
      tool: 'admin.anya.runAutonomous',
      output,
    })
  } catch (err) {
    routeLogger.error('[admin/anya/runAutonomous] Error:', err)
    return res.status(Number(err?.status) || 500).json({
      id: crypto.randomUUID(),
      tool: 'admin.anya.runAutonomous',
      output: {
        success: false,
        code: err?.code || 'ANYA_AUTONOMOUS_FAILED',
        error: err?.message || String(err),
      },
    })
  }
})

export default router;
