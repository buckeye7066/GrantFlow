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
import { buildProfileSignals, calculateMatchScore } from '../services/profileHelpers.js';
import { getSystemDiagnostics } from '../services/diagnosticsService.js';
import { listClientSignInEvents } from '../services/adminLoginEventStore.js'
import { linkProfileToAdmin } from '../utils/adminProfileLinks.js';
import { dispatchCrawlerJob } from '../services/crawlerDispatcher.js';
import { logAuditEvent, queryAuditLogs, getAuditSummary, cleanupAuditLogs, AUDIT_CATEGORIES, SEVERITY } from '../services/auditService.js';
import { initializeFeatureFlags, isFeatureEnabled, getAllFlags, updateFlag, createFlagOverride, removeFlagOverride, getFlagOverrides, cleanupExpiredOverrides } from '../services/featureFlagService.js';
import { getProfileWithLocation } from '../services/crawlers/crawlerHelpers.js';
import { getRequestError } from '../services/requestIdErrorStore.js';
import { crawlLocalFunding } from '../services/crawlers/localFundingCrawler.js';
import { crawlGovernmentFunding } from '../services/crawlers/governmentFundingCrawler.js';
import { crawlStudentGrants } from '../services/crawlers/studentGrantsCrawler.js';
import { crawlSpecialNeeds } from '../services/crawlers/specialNeedsCrawler.js';
import { crawlItemFunding } from '../services/crawlers/itemFundingCrawler.js';
import { crawlECFBenefits } from '../services/crawlers/ecfBenefitsCrawler.js';
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
const countiesByStatePath = process.env.GEO_COUNTIES_BY_STATE_PATH
  ? resolve(process.env.GEO_COUNTIES_BY_STATE_PATH)
  : join(repoRootDir, 'county_batch1.json');

let zipCoordinatesCache = null;
let zipStateIndexCache = null;
let countiesByStateCache = null;
let zipCoordinatesMissing = false;

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

async function ensureAdminRequest(req, res) {
  const user = req.user ?? {};

  // Fast path: middleware already marked admin.
  if (user?.is_admin === true || user?.role === 'admin') {
    return true;
  }

  // Resolve the authenticated user from DB when middleware can't determine admin status
  // (e.g., profile-scoped tokens that only carry profileId).
  try {
    const db = req.db;
    const resolvedUserId = user?.userId
      ? user.userId
      : user?.profileId
        ? (await db.prepare('SELECT user_id FROM profiles WHERE id = ?').get(user.profileId))?.user_id
        : null;

    if (resolvedUserId) {
      const row = await db
        .prepare('SELECT is_admin, primary_email FROM users WHERE id = ?')
        .get(resolvedUserId);
      const email = String(row?.primary_email || '').toLowerCase();

      if (row?.is_admin === true || row?.is_admin === 1) {
        return true;
      }

      // Backwards-compatible admin allow-list.
      if (email && email.includes('buckeye7066')) {
        return true;
      }
    }
  } catch (error) {
    // fall through to 403
  }

  res.status(403).json({
    error: 'Access denied',
    message: 'This endpoint is restricted to administrators only',
  });
  return false;
}

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
    // Check admin access - use consistent admin enforcement (is_admin flag or email-based)
    const user = req.user;
    const userEmail = user?.primary_email || user?.email || '';
    const isAdmin = user?.is_admin === true || user?.role === 'admin' || 
                    (userEmail && userEmail.toLowerCase().includes('buckeye7066'));
    
    if (!isAdmin) {
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
    const openai = getOpenAI();
    const completion = await openai.chat.completions.create({
      model: AI_MODEL,
      messages: [
        {
          role: 'system',
          content: PROFILE_EXTRACTION_PROMPT,
        },
        {
          role: 'user',
          content: `Extract profile information from this document:\n\n${extractedText.slice(0, MAX_TEXT_LENGTH_FOR_AI)}`,
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    });

    const extractedDataStr = completion.choices[0]?.message?.content;
    if (!extractedDataStr) {
      throw new Error('OpenAI returned empty response');
    }

    const extractedData = JSON.parse(extractedDataStr);

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
          getOpenAI,
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
      error: error.message || 'Failed to process document and create profile',
      details: error.toString()
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
      WHERE is_admin = TRUE OR LOWER(primary_email) LIKE '%buckeye7066%'
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
    res.json({ counties: list.map((county) => ({ county })) });
  } catch (error) {
    console.error('[admin/geo/state/counties] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/geo/state/:state/index-counties', async (req, res) => {
  try {
    if (!(await ensureAdminRequest(req, res))) return;
    // Counties are shipped from a bundled JSON file. This endpoint exists so the UI can
    // confirm availability / future-proof for DB-backed indexing.
    const job = { id: crypto.randomUUID(), status: 'completed' };
    res.json({ success: true, job });
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

    // Get all profiles
    const profiles = await req.db.prepare('SELECT id, display_name FROM profiles').all();

    const results = {
      profiles_processed: 0,
      sections_created: 0,
      details: []
    };

    const upsert = req.db.prepare(`
      INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
      VALUES (?, ?, '{}', 'admin-repair')
      ON CONFLICT(profile_id, section_key) DO NOTHING
    `);

    const transaction = req.db.transaction(() => {
      for (const profile of profiles) {
        const existingSections = req.db
          .prepare('SELECT section_key FROM profile_sections WHERE profile_id = ?')
          .all(profile.id);
        
        const existingKeys = new Set(existingSections.map(s => s.section_key));
        const createdForProfile = [];

        supportedSectionKeys.forEach(sectionKey => {
          if (!existingKeys.has(sectionKey)) {
            upsert.run(profile.id, sectionKey);
            createdForProfile.push(sectionKey);
          }
        });

        results.profiles_processed++;
        results.sections_created += createdForProfile.length;

        if (createdForProfile.length > 0) {
          results.details.push({
            profile_id: profile.id,
            display_name: profile.display_name,
            sections_created: createdForProfile.length
          });
        }
      }
    });

    transaction();

    // Log audit event
    try {
      req.db.prepare(`
        INSERT INTO audit_logs (event_type, user_id, details, created_at)
        VALUES ('admin_repair_all_profiles', ?, ?, CURRENT_TIMESTAMP)
      `).run(
        req.user?.userId ?? 'admin',
        JSON.stringify({
          profiles_processed: results.profiles_processed,
          sections_created: results.sections_created,
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

/**
 * National ZIP crawl management endpoints
 */

// Track running national crawl jobs
let nationalCrawlJob = null

/**
 * Start national ZIP crawl
 * POST /api/admin/national-crawl/start
 */
router.post('/national-crawl/start', async (req, res) => {
  try {
    if (nationalCrawlJob && nationalCrawlJob.status === 'running') {
      return res.status(409).json({
        error: 'National crawl already running',
        job_id: nationalCrawlJob.id
      })
    }
    
    const { batch_size, min_sources_per_zip } = req.body
    const db = req.db
    
    // Import national ZIP crawler
    const { runNationalZipCrawl } = await import('../services/crawlers/nationalZipCrawler.js')
    
    // Create job record
    const jobId = crypto.randomUUID()
    const params = {
      batch_size: batch_size || 50,
      min_sources_per_zip: min_sources_per_zip || 3
    }
    
    await db.prepare(`
      INSERT INTO crawler_jobs (
        id, type, status, parameters, requested_by, created_at
      ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
      jobId,
      'national_zip_scan',
      'running',
      JSON.stringify(params),
      req.user?.id || 'admin'
    )
    
    nationalCrawlJob = {
      id: jobId,
      status: 'running',
      started_at: new Date().toISOString()
    }
    
    // Run crawl in background
    const dbPath = process.env.DB_PATH || join(__dirname, '..', 'data', 'grantflow.db')
    
    runNationalZipCrawl(dbPath, params)
      .then(async (result) => {
        nationalCrawlJob.status = 'completed'
        nationalCrawlJob.completed_at = new Date().toISOString()
        nationalCrawlJob.result = result
        
        // Update job record
        await db.prepare(`
          UPDATE crawler_jobs 
          SET status = 'completed', 
              completed_at = CURRENT_TIMESTAMP,
              result_count = ?,
              result_meta = ?
          WHERE id = ?
        `).run(result.sources, JSON.stringify(result), jobId)
      })
      .catch(async (error) => {
        nationalCrawlJob.status = 'failed'
        nationalCrawlJob.error = error.message
        
        // Update job record
        await db.prepare(`
          UPDATE crawler_jobs 
          SET status = 'failed', 
              completed_at = CURRENT_TIMESTAMP,
              error = ?
          WHERE id = ?
        `).run(error.message, jobId)
      })
    
    res.json({
      success: true,
      job_id: jobId,
      message: 'National ZIP crawl started',
      parameters: params
    })
  } catch (error) {
    console.error('[admin/national-crawl/start] Error:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * Stop national ZIP crawl
 * POST /api/admin/national-crawl/stop
 */
router.post('/national-crawl/stop', async (req, res) => {
  try {
    if (!nationalCrawlJob || nationalCrawlJob.status !== 'running') {
      return res.status(404).json({
        error: 'No national crawl currently running'
      })
    }
    
    // Mark as cancelled (actual stopping would require more complex implementation)
    nationalCrawlJob.status = 'cancelled'
    nationalCrawlJob.cancelled_at = new Date().toISOString()
    
    // Update job record
    await req.db.prepare(`
      UPDATE crawler_jobs 
      SET status = 'cancelled', 
          completed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(nationalCrawlJob.id)
    
    res.json({
      success: true,
      message: 'National ZIP crawl stopped',
      job_id: nationalCrawlJob.id
    })
  } catch (error) {
    console.error('[admin/national-crawl/stop] Error:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * Get national ZIP crawl status
 * GET /api/admin/national-crawl/status
 */
router.get('/national-crawl/status', async (req, res) => {
  try {
    const db = req.db
    // This endpoint is polled by the Admin UI; prevent conditional GETs (304) which break JSON parsing.
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
    res.set('Pragma', 'no-cache')
    res.set('Expires', '0')
    res.set('Surrogate-Control', 'no-store')
    
    // Get current job status if running
    if (nationalCrawlJob) {
      // Get progress from database
      const progress = await db.prepare(`
        SELECT 
          COUNT(*) as total_zips,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_zips,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_zips,
          SUM(sources_found) as total_sources,
          AVG(sources_found) as avg_sources
        FROM national_zip_progress
      `).get()
      
      return res.json({
        job: nationalCrawlJob,
        progress: {
          total_zips: progress.total_zips || 0,
          completed: progress.completed_zips || 0,
          failed: progress.failed_zips || 0,
          sources_found: progress.total_sources || 0,
          avg_sources_per_zip: progress.avg_sources || 0
        }
      })
    }
    
    // Get last completed job
    const lastJob = await db.prepare(`
      SELECT * FROM crawler_jobs 
      WHERE type = 'national_zip_scan' 
      ORDER BY created_at DESC 
      LIMIT 1
    `).get()
    
    if (!lastJob) {
      return res.json({
        message: 'No national crawl jobs found',
        progress: null
      })
    }
    
    // Get final progress
    const progress = await db.prepare(`
      SELECT 
        COUNT(*) as total_zips,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_zips,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_zips,
        SUM(sources_found) as total_sources,
        AVG(sources_found) as avg_sources
      FROM national_zip_progress
    `).get()
    
    res.json({
      last_job: {
        id: lastJob.id,
        status: lastJob.status,
        started_at: lastJob.started_at,
        completed_at: lastJob.completed_at,
        result_count: lastJob.result_count,
        error: lastJob.error
      },
      progress: {
        total_zips: progress.total_zips || 0,
        completed: progress.completed_zips || 0,
        failed: progress.failed_zips || 0,
        sources_found: progress.total_sources || 0,
        avg_sources_per_zip: progress.avg_sources || 0
      }
    })
  } catch (error) {
    console.error('[admin/national-crawl/status] Error:', error)
    res.status(500).json({ error: error.message })
  }
})

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
    
    const isAdmin = Boolean(req.user?.is_admin || req.user?.role === 'admin');
    const enabled = isFeatureEnabled(req.db, key, {
      userId: userId || req.user?.userId,
      profileId: profileId || req.user?.profileId,
      isAdmin,
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

export default router;
