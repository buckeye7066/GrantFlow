import express from 'express';
import crypto from 'crypto';
import multer from 'multer';
import fs from 'fs';
import net from 'net'
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
import { buildProfileSignals, calculateMatchScore } from '../services/profileHelpers.js';
import { getSystemDiagnostics } from '../services/diagnosticsService.js';
import { getFundingSourceStatus } from '../src/config/fundingSources.js'
import { listClientSignInEvents } from '../services/adminLoginEventStore.js'
import { linkProfileToAdmin } from '../utils/adminProfileLinks.js';
import { dispatchCrawlerJob } from '../services/crawlerDispatcher.js';
import { logAuditEvent, queryAuditLogs, getAuditSummary, cleanupAuditLogs, AUDIT_CATEGORIES, SEVERITY } from '../services/auditService.js';
import { initializeFeatureFlags, isFeatureEnabled, getAllFlags, updateFlag, createFlagOverride, removeFlagOverride, getFlagOverrides, cleanupExpiredOverrides } from '../services/featureFlagService.js';
import { getProfileWithLocation } from '../services/crawlers/crawlerHelpers.js';
import { getRequestError } from '../services/requestIdErrorStore.js';
import { extractTextFromFile } from '../services/documentTextExtraction.js'
import { crawlLocalFunding } from '../services/crawlers/localFundingCrawler.js';
import { crawlGovernmentFunding } from '../services/crawlers/governmentFundingCrawler.js';
import { crawlStudentGrants } from '../services/crawlers/studentGrantsCrawler.js';
import { crawlSpecialNeeds } from '../services/crawlers/specialNeedsCrawler.js';
import { crawlItemFunding } from '../services/crawlers/itemFundingCrawler.js';
import { crawlECFBenefits } from '../services/crawlers/ecfBenefitsCrawler.js';
import { findDuplicateProfileGroups, mergeProfiles } from '../services/profileDedupeService.js'
import { ensureAdminUser, isAdminUser } from '../utils/accessControl.js'
import zipcodes from 'zipcodes';

const router = express.Router();

// Configuration constants
const MAX_TEXT_LENGTH_FOR_AI = 10000; // Maximum characters to send to OpenAI
const AI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini'; // Configurable AI model

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRootDir = join(__dirname, '..', '..');
const uploadDir = process.env.UPLOADS_DIR
  ? resolve(process.env.UPLOADS_DIR)
  : join(__dirname, '..', 'uploads');

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
let zipCoordinatesMissing = false;

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
  'local_funding',
  'government_funding',
  'student_grants',
  'special_needs',
  'item_matching',
  'ecf_benefits',
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

// ----------------------------
// Funding Providers (no secrets)
// ----------------------------
router.get('/funding-sources', async (req, res) => {
  if (!(await ensureAdminRequest(req, res))) return
  res.json({ sources: getFundingSourceStatus() })
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
  if (countiesByStateCache) return countiesByStateCache;
  if (!fs.existsSync(countiesByStatePath)) {
    countiesByStateCache = {};
    return countiesByStateCache;
  }
  countiesByStateCache = JSON.parse(fs.readFileSync(countiesByStatePath, 'utf8'));
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

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const extension = file.originalname.includes('.') ? `.${file.originalname.split('.').pop()}` : '';
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

function kbMulterFileFilter(_req, file, cb) {
  const extension = (file?.originalname?.split('.').pop() || '').toLowerCase()
  const allowedExt = new Set([
    'pdf',
    'doc',
    'docx',
    'txt',
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
  const ok = KB_ALLOWED_MIME_TYPES.has(file?.mimetype) || allowedExt.has(extension)
  if (!ok) return cb(new Error('Unsupported file type'))
  return cb(null, true)
}

const knowledgeUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => {
      const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`
      const extension = file.originalname.includes('.') ? `.${file.originalname.split('.').pop()}` : ''
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

function isPrivateIpAddress(ip) {
  // IPv4 private ranges: 10/8, 172.16/12, 192.168/16, 127/8, 169.254/16
  const v = net.isIP(ip)
  if (v === 4) {
    const parts = ip.split('.').map((n) => Number(n))
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true
    const [a, b] = parts
    if (a === 10) return true
    if (a === 127) return true
    if (a === 0) return true
    if (a === 169 && b === 254) return true
    if (a === 192 && b === 168) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    return false
  }

  // IPv6 loopback/link-local/ULA
  if (v === 6) {
    const lower = ip.toLowerCase()
    if (lower === '::1') return true // loopback
    if (lower.startsWith('fe80:')) return true // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true // unique local
    return false
  }

  return true
}

function assertRemoteUrlAllowed(rawUrl) {
  let parsed
  try {
    parsed = new URL(String(rawUrl))
  } catch {
    throw new Error('Invalid URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http(s) URLs are supported')
  }

  const hostname = (parsed.hostname || '').toLowerCase().trim()
  if (!hostname) throw new Error('Invalid URL host')
  if (hostname === 'localhost' || hostname === '0.0.0.0' || hostname.endsWith('.local')) {
    throw new Error('URL host is not allowed')
  }
  if (net.isIP(hostname)) {
    if (isPrivateIpAddress(hostname)) throw new Error('URL host is not allowed')
  }

  return parsed
}

async function downloadRemoteFileToUploads({ url }) {
  const initial = assertRemoteUrlAllowed(url)
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 20_000)
  try {
    const resp = await fetch(initial.toString(), { signal: controller.signal })
    if (!resp.ok) throw new Error(`Unable to download file (${resp.status})`)
    try {
      if (resp.url) assertRemoteUrlAllowed(resp.url)
    } catch {
      throw new Error('Final URL host is not allowed')
    }

    const contentType = resp.headers.get('content-type') || 'application/octet-stream'
    const contentLength = Number(resp.headers.get('content-length') || '0')
    if (contentLength && contentLength > KB_MAX_FILE_BYTES) {
      throw new Error('Remote file is too large (max 50MB).')
    }

    const fileNameFromUrl = (() => {
      try {
        const parsed = new URL(url)
        return parsed.pathname.split('/').pop() || 'remote-upload'
      } catch {
        return 'remote-upload'
      }
    })()

    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`
    const extension = fileNameFromUrl.includes('.') ? `.${fileNameFromUrl.split('.').pop()}` : ''
    const filename = `kb-${unique}${extension}`
    const absPath = join(uploadDir, filename)

    const buf = Buffer.from(await resp.arrayBuffer())
    if (buf.length > KB_MAX_FILE_BYTES) {
      throw new Error('Remote file is too large (max 50MB).')
    }
    await fsp.writeFile(absPath, buf)

    return {
      file: {
        path: absPath,
        size: buf.length,
        mimetype: contentType,
        originalname: fileNameFromUrl,
        filename,
      },
      publicUrl: `/uploads/${filename}`,
    }
  } finally {
    clearTimeout(timeoutId)
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
        model: process.env.ANTHROPIC_MODEL || 'claude-3-haiku-20240307',
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

  try {
    const { openai, diagnostics } = createOpenAIClient();
    // A lightweight call that should succeed with a valid key.
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
    // Always return redacted diagnostics even on failure.
    const { diagnostics } = createOpenAIClient({ allowMissing: true });
    res.status(summary.isAuth ? 401 : 500).json({
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
    res.status(summary.isAuth ? 401 : 500).json({
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

    res.status(summary.isAuth ? 401 : 500).json({
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
  const value = valueRaw == null ? '' : String(valueRaw);
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

  const SECRET_KEYS = new Set(['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'RESEND_API_KEY', 'ANYA_ADMIN_TOKEN']);

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
  const s = value == null ? '' : String(value)
  const t = s.trim()
  return t ? t : ''
}

function safeDeleteFile(filePath) {
  try {
    const raw = safeTrim(filePath)
    if (!raw) return false
    const resolved = resolve(raw)
    const base = resolve(uploadDir)
    if (!resolved.startsWith(base)) return false
    if (!fs.existsSync(resolved)) return false
    fs.unlinkSync(resolved)
    return true
  } catch {
    return false
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
    if (req.file?.path) safeDeleteFile(req.file.path)
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

    const doc = await req.db.prepare(`SELECT * FROM documents WHERE id = ? LIMIT 1`).get(docId)
    res.status(201).json({ ok: true, document: doc })
  } catch (error) {
    if (req.file?.path) safeDeleteFile(req.file.path)
    res.status(500).json({ ok: false, error: error?.message || String(error) })
  }
})

// POST /api/admin/knowledge/ingest-url
// Body: { url, name?, notes?, ocr?, handwriting?, ocr_language? }
router.post('/knowledge/ingest-url', async (req, res) => {
  if (!(await ensureAdminRequest(req, res))) return
  let downloaded = null
  try {
    const url = safeTrim(req.body?.url)
    if (!url) return res.status(400).json({ ok: false, error: 'url is required' })

    downloaded = await downloadRemoteFileToUploads({ url })
    const file = downloaded.file

    const name = safeTrim(req.body?.name) || safeTrim(file.originalname) || 'Knowledge Document'
    const notes = safeTrim(req.body?.notes) || null

    let extractedText = null
    try {
      const ocr = req.body?.ocr === 'true' || req.body?.ocr === true
      const handwriting = req.body?.handwriting === 'true' || req.body?.handwriting === true
      const ocrLanguage = safeTrim(req.body?.ocr_language) || 'eng'
      const result = await extractTextFromFile({
        filePath: file.path,
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

    const doc = await req.db.prepare(`SELECT * FROM documents WHERE id = ? LIMIT 1`).get(docId)
    res.status(201).json({ ok: true, document: doc })
  } catch (error) {
    if (downloaded?.file?.path) safeDeleteFile(downloaded.file.path)
    res.status(500).json({ ok: false, error: error?.message || String(error) })
  }
})

// DELETE /api/admin/knowledge/:id
router.delete('/knowledge/:id', async (req, res) => {
  if (!(await ensureAdminRequest(req, res))) return
  try {
    const id = safeTrim(req.params?.id)
    const doc = await req.db
      .prepare(`SELECT id, file_path FROM documents WHERE id = ? AND type = ? LIMIT 1`)
      .get(id, KB_DOCUMENT_TYPE)
    if (!doc) return res.status(404).json({ ok: false, error: 'Not found' })

    await req.db.prepare(`DELETE FROM documents WHERE id = ?`).run(id)
    const deletedFile = doc.file_path ? safeDeleteFile(doc.file_path) : false

    res.json({ ok: true, deleted: true, deleted_file: deletedFile })
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
    return res.status(summary.isAuth ? 401 : 500).json({
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
    const user = req.user;
    const adminCheck = isAdminUser(user);
    
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
          uploadDir,
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
    
    // User mappings
    const userMappings = [
      { name: 'Rachel', emailPattern: 'rachel' },
      { name: 'Josh', emailPattern: 'josh' },
      { name: 'Olivia', emailPattern: 'olivia' },
      { name: 'Avanell', emailPattern: 'avanell' },
      { name: 'Hollie', emailPattern: 'hollie' },
      { name: 'Brian', emailPattern: 'brian' },
    ];
    
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

// GET /api/admin/login-events - Recent client logins (admin only)
// Stored in-memory only (best-effort; cleared on restart).
router.get('/login-events', async (req, res) => {
  try {
    if (!(await ensureAdminRequest(req, res))) return

    // Polled by the Admin UI; prevent conditional GETs (304) which break JSON parsing.
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
    res.set('Pragma', 'no-cache')

    const since = typeof req.query?.since === 'string' ? req.query.since : null
    const limitRaw = typeof req.query?.limit === 'string' ? req.query.limit : null
    const limit = limitRaw ? Number(limitRaw) : 25

    return res.json({
      ok: true,
      events: listClientSignInEvents({ since, limit }),
    })
  } catch (error) {
    console.error('[admin/login-events] Error:', error)
    return res.status(500).json({ error: 'Failed to load login events' })
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

router.get('/geo/state/:state/counties', async (req, res) => {
  try {
    if (!(await ensureAdminRequest(req, res))) return;
    const state = String(req.params.state || '').toUpperCase();
    const countiesByState = loadCountiesByState();
    const list = Array.isArray(countiesByState?.[state]) ? countiesByState[state] : [];
    res.json({
      counties: list.map((county) => ({ county })),
      available: list.length > 0,
      source:
        process.env.GEO_COUNTIES_BY_STATE_PATH && fs.existsSync(resolve(process.env.GEO_COUNTIES_BY_STATE_PATH))
          ? 'GEO_COUNTIES_BY_STATE_PATH'
          : fs.existsSync(countiesByStatePath)
            ? 'fallback_file'
            : 'missing',
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
      const fetched = await fetchCountiesFromCensus(state)
      if (fetched.length) {
        countiesByState[state] = fetched
        list = fetched
        source = 'census_api'
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
          : 'No counties available for this state. If GEO_COUNTIES_BY_STATE_PATH is not set, ensure outbound HTTPS is allowed to reach the US Census API.',
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
        failed: resultMeta?.failed ?? null,
        skipped: resultMeta?.skipped ?? null,
      },
    })
  } catch (error) {
    console.error('[admin/geo/crawl/status] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/geo/crawl/start', async (req, res) => {
  try {
    if (!(await ensureAdminRequest(req, res))) return;
    const payload = req.body ?? {};

    // IMPORTANT: crawler_jobs.type is CHECK-constrained in production. Use an allowed type.
    // We tag the job with parameters.mode='geo' so it can be queried separately from other comprehensive runs.
    const incoming = payload && typeof payload === 'object' ? payload : {}

    // UI payload normalization:
    // - AdminGeoCrawl sends `zips`, but the crawler expects `zip_list`.
    // - Provide a sane `max_zips` default when a zip list is provided.
    // - Enable local-resource discovery by default for Geo Crawl (new source discovery).
    const zipList =
      Array.isArray(incoming.zips) && incoming.zips.length > 0
        ? incoming.zips
        : Array.isArray(incoming.zip_list) && incoming.zip_list.length > 0
          ? incoming.zip_list
          : null

    const parameters = {
      ...incoming,
      mode: 'geo',
      zip_list: zipList ?? undefined,
      max_zips:
        zipList && zipList.length > 0
          ? zipList.length
          : incoming.max_zips ?? incoming.maxZips ?? undefined,
      // Feature toggles (crawler reads these)
      discover_local_resources:
        incoming.discover_local_resources ?? incoming.discoverLocalResources ?? true,
      // Conservative defaults; can be overridden per request
      overpass_radius_km: incoming.overpass_radius_km ?? 12,
      overpass_max_results: incoming.overpass_max_results ?? 60,
    }

    // Avoid persisting UI-only keys.
    delete parameters.zips

    const jobId = crypto.randomUUID();
    await req.db
      .prepare(
        `
          INSERT INTO crawler_jobs (id, type, status, profile_id, organization_id, parameters, requested_by)
          VALUES (?, 'comprehensive', 'queued', NULL, NULL, ?, 'admin')
        `,
      )
      .run(jobId, JSON.stringify(parameters));

    const job = await req.db
      .prepare('SELECT id, type, status, created_at, started_at, completed_at, result_count, error FROM crawler_jobs WHERE id = ?')
      .get(jobId);

    // Dispatch asynchronously (don't block response).
    try {
      dispatchCrawlerJob({
        db: req.db,
        jobId: job.id,
        uploadDir,
        getOpenAI,
      });
    } catch (error) {
      console.warn('[admin/geo/crawl/start] Failed to dispatch job:', error?.message || error);
    }

    res.status(201).json({ success: true, job });
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
    const result = seedAssistanceDirectories(req.db);
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
  try {
    const { excludeProfiles = [] } = req.body || {};
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

      const profileContext = { profile: profile, sections: sections };
      const profileSignals = buildProfileSignals(profileContext);

      const scored = opportunities.map(opp => {
        const { score, matchedFields } = calculateMatchScore(profileSignals, opp);
        return { opp, score, matchedFields };
      });

      const topMatches = scored.filter(s => s.score >= 45).sort((a, b) => b.score - a.score).slice(0, 50);

      let orgId = profile.organization_id;
      if (!orgId) {
        orgId = crypto.randomUUID();
        await req.db
          .prepare(
            `INSERT INTO organizations (id, name, applicant_type, created_at, updated_at) VALUES (?, ?, 'individual_need', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          )
          .run(orgId, profile.display_name || 'My Organization');
        await req.db.prepare('UPDATE profiles SET organization_id = ? WHERE id = ?').run(orgId, profile.id);
      }

      let added = 0;
      for (const { opp, score, matchedFields } of topMatches) {
        const existing = await req.db
          .prepare('SELECT id FROM grants WHERE organization_id = ? AND (funding_opportunity_id = ? OR title = ?)')
          .get(orgId, opp.id, opp.title);
        if (!existing) {
          try {
            await req.db.prepare(`
              INSERT INTO grants (id, organization_id, funding_opportunity_id, title, funder, deadline, status, match_score, match_reasons, application_url, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, 'interested', ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            `).run(crypto.randomUUID(), orgId, opp.id, opp.title, opp.sponsor, opp.deadline, score, JSON.stringify((matchedFields || []).slice(0, 10)), opp.application_url);
            added++;
          } catch (e) { /* ignore duplicates */ }
        }
      }
      results.push({ profile: profile.display_name, status: 'seeded', opportunities_found: topMatches.length, grants_added: added });
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
    console.log('[admin/ingest] Starting manual ingestion...');
    
    // Import connectors dynamically
    const { fetchGrantsGov } = await import('../services/sources/grantsGov.js');
    const { fetchUSASpending } = await import('../services/sources/usaSpending.js');
    const { ingestOpportunities } = await import('../services/sources/ingestionService.js');
    
    const results = [];
    
    // Ingest from Grants.gov
    try {
      console.log('[admin/ingest] Fetching from Grants.gov...');
      const { opportunities: grantsGovOpps } = await fetchGrantsGov({ limit: 100, offset: 0 });
      const grantsGovResult = ingestOpportunities(req.db, grantsGovOpps, 'grants.gov');
      results.push({ source: 'grants.gov', ...grantsGovResult });
    } catch (error) {
      console.error('[admin/ingest] Grants.gov error:', error.message);
      results.push({ source: 'grants.gov', success: false, error: error.message });
    }
    
    // Ingest from USASpending.gov
    try {
      console.log('[admin/ingest] Fetching from USASpending.gov...');
      const { opportunities: usaSpendingOpps } = await fetchUSASpending({ limit: 100, page: 1 });
      const usaSpendingResult = ingestOpportunities(req.db, usaSpendingOpps, 'usaspending.gov');
      results.push({ source: 'usaspending.gov', ...usaSpendingResult });
    } catch (error) {
      console.error('[admin/ingest] USASpending.gov error:', error.message);
      results.push({ source: 'usaspending.gov', success: false, error: error.message });
    }
    
    // Calculate totals
    const summary = {
      sources_processed: results.length,
      successes: results.filter(r => r.success).length,
      failures: results.filter(r => !r.success).length,
      total_inserted: results.reduce((sum, r) => sum + (r.records_inserted || 0), 0),
      total_updated: results.reduce((sum, r) => sum + (r.records_updated || 0), 0),
      total_errors: results.reduce((sum, r) => sum + (r.errors || 0), 0),
    };
    
    console.log('[admin/ingest] Ingestion completed:', summary);
    
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
    
    const adminCheck = isAdminUser(req.user);
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
 *  - min_match_score?: number (defaults 50)
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
      min_match_score = 50,
      timeout_ms = 20000,
      limit_profiles = 25,
      item_request = null,
    } = req.body ?? {};

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
      let profile = null;
      let profileContextError = null;
      try {
        profile = await getProfileWithLocation(req.db, profileId);
      } catch (error) {
        profileContextError = error?.message || String(error);
      }

      const signals = profile?.signals ?? null;
      const location = signals?.location ?? {};
      const keywordCount = signals?.keywordSet?.size ?? 0;
      const coverage = signals?.coverage ?? null;

      const profileRow = {
        profile_id: profileId,
        display_name: p.display_name,
        primary_type: p.primary_type,
        status: p.status,
        coverage,
        signals_summary: {
          has_zip: Boolean(location?.zip),
          has_state: Boolean(location?.state),
          keyword_count: keywordCount,
        },
        error: profileContextError,
        crawlers: [],
      };

      for (const crawlerType of types) {
        const startedAt = Date.now();
        let ok = true;
        let errorMessage = null;
        let opportunities = [];

        // Pre-flight "why would this be 0" hints (fast, high-signal).
        const hints = [];
        if (!profile) {
          hints.push('profile_context_failed');
        } else {
          if (crawlerType === 'local_funding' && !location?.zip) hints.push('missing_zip');
          if (crawlerType === 'item_matching' && !item_request) hints.push('missing_item_request');
          if (crawlerType === 'student_grants') {
            const t = String(p.primary_type || '').toLowerCase();
            const isStudent = ['high_school_student', 'college_student', 'graduate_student', 'student'].includes(t);
            if (!isStudent) hints.push('not_student_profile');
          }
        }

        try {
          if (!profile) {
            ok = false;
            errorMessage = profileContextError || 'Profile context unavailable';
          } else {
            const opts = { min_match_score: Number(min_match_score) || 50 };
            const promise = (() => {
              switch (crawlerType) {
                case 'local_funding':
                  return crawlLocalFunding(profile, opts);
                case 'government_funding':
                  return crawlGovernmentFunding(profile, opts);
                case 'student_grants':
                  return crawlStudentGrants(profile, opts);
                case 'special_needs':
                  return crawlSpecialNeeds(profile, opts);
                case 'item_matching':
                  return crawlItemFunding(profile, { item_request });
                case 'ecf_benefits':
                  return crawlECFBenefits(profile, opts);
                default:
                  return Promise.resolve([]);
              }
            })();

            const raw = await withTimeout(promise, Math.max(1000, Number(timeout_ms) || 20000), `audit:${crawlerType}`);
            opportunities = Array.isArray(raw) ? raw : [];
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
      timeout_ms,
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
      groups: report.groups,
    })
  } catch (error) {
    console.error('[admin/profiles/duplicates] Error:', error)
    return next(error)
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
    const dryRun = req.body?.dryRun !== false

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
    console.error('[admin/profiles/merge] Error:', error)
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

async function chooseWinnerForGroup(db, memberIds) {
  const ids = Array.from(new Set((memberIds || []).filter(Boolean).map(String)))
  if (ids.length < 2) return ids[0] ?? null

  const placeholders = ids.map(() => '?').join(', ')
  const profiles = await db
    .prepare(
      `
        SELECT id, user_id, display_name, updated_at
        FROM profiles
        WHERE id IN (${placeholders})
      `,
    )
    .all(...ids)

  const metricsRows = await db
    .prepare(
      `
        SELECT profile_id, COUNT(*) as section_count, COALESCE(SUM(LENGTH(data)), 0) as data_bytes
        FROM profile_sections
        WHERE profile_id IN (${placeholders})
        GROUP BY profile_id
      `,
    )
    .all(...ids)

  const metricsByProfile = new Map()
  for (const row of metricsRows || []) {
    metricsByProfile.set(String(row.profile_id), {
      sectionCount: Number(row.section_count ?? row.count ?? 0) || 0,
      dataBytes: Number(row.data_bytes ?? 0) || 0,
    })
  }

  const emailsByProfile = await loadProfileEmailSignals(db, ids)

  const userIds = Array.from(new Set((profiles || []).map((p) => p.user_id).filter(Boolean).map(String)))
  const usersById = new Map()
  if (userIds.length > 0) {
    const userPlaceholders = userIds.map(() => '?').join(', ')
    const users = await db
      .prepare(
        `
          SELECT id, primary_email, is_admin
          FROM users
          WHERE id IN (${userPlaceholders})
        `,
      )
      .all(...userIds)
    for (const u of users || []) usersById.set(String(u.id), u)
  }

  let best = null
  let bestScore = -Infinity

  for (const p of profiles || []) {
    const pid = String(p.id)
    const m = metricsByProfile.get(pid) || { sectionCount: 0, dataBytes: 0 }
    const updated = Date.parse(p.updated_at ?? '') || 0
    const emails = emailsByProfile.get(pid) || new Set()
    const user = p.user_id ? usersById.get(String(p.user_id)) : null
    const userEmail = normalizeEmail(user?.primary_email)
    const isAdmin = Boolean(user?.is_admin === true || user?.is_admin === 1)
    const ownerEmailMatchesProfile = Boolean(userEmail && emails.has(userEmail))
    const hasNonAdminOwner = Boolean(user && !isAdmin)

    // Hard preference: keep the profile owned by the real (non-admin) user whose email matches the profile email.
    const ownershipWeight =
      ownerEmailMatchesProfile && hasNonAdminOwner ? 1_000_000_000 :
      hasNonAdminOwner ? 1_000_000 :
      isAdmin ? 10_000 :
      0

    const completenessWeight = m.sectionCount * 10_000 + Math.floor(m.dataBytes / 10)
    const score = ownershipWeight + completenessWeight + Math.floor(updated / 1_000_000)

    if (score > bestScore) {
      bestScore = score
      best = pid
    }
  }

  return best ?? ids[0] ?? null
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

    const strategy = String(req.body?.strategy || req.query?.strategy || 'exact_name')
    const includeInactive = String(req.body?.includeInactive || req.query?.includeInactive || '').toLowerCase() === 'true'
    const limitGroups = Math.max(1, Math.min(Number(req.body?.limitGroups ?? req.query?.limitGroups) || 500, 2000))
    const minGroupSize = Math.max(2, Math.min(Number(req.body?.minGroupSize ?? req.query?.minGroupSize) || 2, 50))
    const dryRun = req.body?.dryRun === true

    const report = await findDuplicateProfileGroups(req.db, { strategy, limitGroups, minGroupSize, includeInactive })
    const groups = report?.groups || []

    const actorUserId = req.ctx?.userId ?? req.user?.userId ?? null

    const results = []
    for (const g of groups) {
      const memberIds = [g?.winner?.id, ...(g?.losers || []).map((l) => l?.id)].filter(Boolean)
      if (memberIds.length < 2) continue

      const winnerId = await chooseWinnerForGroup(req.db, memberIds)
      const loserIds = memberIds.filter((id) => String(id) !== String(winnerId))
      if (!winnerId || loserIds.length === 0) continue

      const merged = await mergeProfiles(req.db, { winnerId, loserIds, dryRun, actorUserId })
      results.push({
        key: g.key,
        winnerId,
        loserIds,
        dry_run: merged?.dry_run ?? dryRun,
        changes: merged?.changes ?? [],
      })
    }

    return res.json({
      ok: true,
      strategy,
      includeInactive,
      limitGroups,
      minGroupSize,
      dryRun,
      merged_groups: results.length,
      results,
    })
  } catch (error) {
    console.error('[admin/profiles/deduplicate] Error:', error)
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
export default router;
