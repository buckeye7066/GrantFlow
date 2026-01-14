import express from 'express';
import crypto from 'crypto';
import multer from 'multer';
import fs from 'fs';
import { promises as fsp } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import pdfParse from 'pdf-parse';
import { createOpenAIClient, summarizeOpenAIError } from '../utils/openaiClient.js';
import { encryptRuntimeSecret } from '../utils/runtimeSecrets.js';
import { seedRealOpportunities } from '../utils/seedRealOpportunities.js';
import { seedAssistanceDirectories } from '../utils/seedAssistanceDirectories.js';
import { ensureDesignatedProfiles } from '../utils/ensureDesignatedProfiles.js';
import { buildProfileSignals, calculateMatchScore } from '../services/profileHelpers.js';
import { getSystemDiagnostics } from '../services/diagnosticsService.js';
import { linkProfileToAdmin } from '../utils/adminProfileLinks.js';
import { dispatchCrawlerJob } from '../services/crawlerDispatcher.js';
import { logAuditEvent, queryAuditLogs, getAuditSummary, cleanupAuditLogs, AUDIT_CATEGORIES, SEVERITY } from '../services/auditService.js';
import { initializeFeatureFlags, isFeatureEnabled, getAllFlags, updateFlag, createFlagOverride, removeFlagOverride, getFlagOverrides, cleanupExpiredOverrides } from '../services/featureFlagService.js';

const router = express.Router();

// Configuration constants
const MAX_TEXT_LENGTH_FOR_AI = 10000; // Maximum characters to send to OpenAI
const AI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini'; // Configurable AI model

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const uploadDir = join(__dirname, '..', 'uploads');
const repoRootDir = join(__dirname, '..', '..');
const zipCoordinatesPath = join(repoRootDir, 'backend', 'data', 'crawlers', 'zip_coordinates.json');
const countiesByStatePath = join(repoRootDir, 'county_batch1.json');

let zipCoordinatesCache = null;
let zipStateIndexCache = null;
let countiesByStateCache = null;

function ensureAdminRequest(req, res) {
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
        ? db.prepare('SELECT user_id FROM profiles WHERE id = ?').get(user.profileId)?.user_id
        : null;

    if (resolvedUserId) {
      const row = db
        .prepare('SELECT is_admin, primary_email FROM users WHERE id = ?')
        .get(resolvedUserId);
      const email = String(row?.primary_email || '').toLowerCase();

      if (row?.is_admin === 1 || row?.is_admin === true) {
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
    throw new Error(`ZIP coordinate dataset missing: ${zipCoordinatesPath}`);
  }
  zipCoordinatesCache = JSON.parse(fs.readFileSync(zipCoordinatesPath, 'utf8'));
  return zipCoordinatesCache;
}

function buildZipStateIndex() {
  if (zipStateIndexCache) return zipStateIndexCache;
  const coords = loadZipCoordinates();
  const index = new Map();

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
  if (!ensureAdminRequest(req, res)) return;

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
  if (!ensureAdminRequest(req, res)) return;

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
  if (!ensureAdminRequest(req, res)) return;

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
      req.db
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
  if (!ensureAdminRequest(req, res)) return;

  try {
    const row = req.db
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
  if (!ensureAdminRequest(req, res)) return;

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
    req.db
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

    const status = req.db
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
    req.db.prepare(
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
    
    req.db.prepare(
      `INSERT INTO documents (
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
        status,
        notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
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
      'active',
      'Uploaded by admin for profile creation'
    );

    req.db.prepare(
      `INSERT OR IGNORE INTO profile_documents (profile_id, document_id) VALUES (?, ?)`
    ).run(profileId, documentId);

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
        insertSection.run(profileId, section.key, JSON.stringify(section.data), `document:${documentId}`);
      }

      // Step 6: Queue and dispatch document_ingest job for deeper AI parsing
      req.db.prepare(`
        INSERT INTO crawler_jobs (type, status, profile_id, parameters, requested_by)
        VALUES ('document_ingest', 'queued', ?, ?, ?)
      `).run(profileId, JSON.stringify({ document_id: documentId, source: 'admin_upload' }), 'admin');
      
      // Get the job and dispatch it immediately
      const parseJob = req.db.prepare('SELECT * FROM crawler_jobs WHERE rowid = last_insert_rowid()').get();
      if (parseJob) {
        dispatchCrawlerJob({
          db: req.db,
          jobId: parseJob.id,
          uploadDir,
          getOpenAI,
        });
      }

      // Get the created profile
      const profile = req.db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId);

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
router.post('/reattach-users', (req, res) => {
  try {
    const db = req.db;
    
    // Get admin user
    const adminUser = db.prepare(`
      SELECT id, display_name, primary_email
      FROM users
      WHERE is_admin = 1 OR LOWER(primary_email) LIKE '%buckeye7066%'
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
      const user = db.prepare(`
        SELECT id, display_name, primary_email
        FROM users
        WHERE LOWER(display_name) LIKE LOWER(?) OR LOWER(primary_email) LIKE LOWER(?)
        LIMIT 1
      `).get(`%${mapping.name}%`, `%${mapping.emailPattern}%`);
      
      if (!user) {
        results.errors.push(`User not found: ${mapping.name}`);
        continue;
      }
      
      const profiles = db.prepare(`
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
        updateStmt.run(user.id, profile.id);
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
    const adminResult = linkAdminStmt.run(adminUser.id);
    results.adminLinked = adminResult.changes;
    
    // Get final stats
    const stats = db.prepare(`
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
router.get('/diagnostics', (req, res) => {
  try {
    if (!ensureAdminRequest(req, res)) return;

    const diagnostics = getSystemDiagnostics(req.db);
    res.json(diagnostics);
  } catch (error) {
    console.error('[admin/diagnostics] Error:', error);
    res.status(500).json({ 
      error: 'Failed to get diagnostics',
      message: error.message || 'An unexpected error occurred'
    });
  }
});

/**
 * Geo Crawl support endpoints (admin-only)
 * These power the Geo Crawl UI state dropdown and scoping selectors.
 */
router.get('/geo/states', (req, res) => {
  try {
    if (!ensureAdminRequest(req, res)) return;
    const index = buildZipStateIndex();
    const states = Array.from(index.keys())
      .sort()
      .map((state) => ({ state, zip_count: index.get(state).length }));
    res.json({ states });
  } catch (error) {
    console.error('[admin/geo/states] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/geo/state/:state/zips', (req, res) => {
  try {
    if (!ensureAdminRequest(req, res)) return;
    const state = String(req.params.state || '').toUpperCase();
    const index = buildZipStateIndex();
    res.json({ zips: index.get(state) ?? [] });
  } catch (error) {
    console.error('[admin/geo/state/zips] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/geo/state/:state/counties', (req, res) => {
  try {
    if (!ensureAdminRequest(req, res)) return;
    const state = String(req.params.state || '').toUpperCase();
    const countiesByState = loadCountiesByState();
    const list = Array.isArray(countiesByState?.[state]) ? countiesByState[state] : [];
    res.json({ counties: list.map((county) => ({ county })) });
  } catch (error) {
    console.error('[admin/geo/state/counties] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/geo/state/:state/index-counties', (req, res) => {
  try {
    if (!ensureAdminRequest(req, res)) return;
    // Counties are shipped from a bundled JSON file. This endpoint exists so the UI can
    // confirm availability / future-proof for DB-backed indexing.
    const job = { id: crypto.randomUUID(), status: 'completed' };
    res.json({ success: true, job });
  } catch (error) {
    console.error('[admin/geo/state/index-counties] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/geo/crawl/status', (req, res) => {
  try {
    if (!ensureAdminRequest(req, res)) return;
    const latest = req.db
      .prepare(
        `
          SELECT id, type, status, created_at, started_at, completed_at, result_count, error
          FROM crawler_jobs
          WHERE type = 'comprehensive'
            AND parameters LIKE '%"mode":"geo"%'
          ORDER BY created_at DESC
          LIMIT 1
        `,
      )
      .get();
    res.json({ geo_crawl: latest ?? null });
  } catch (error) {
    console.error('[admin/geo/crawl/status] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/geo/crawl/start', (req, res) => {
  try {
    if (!ensureAdminRequest(req, res)) return;
    const payload = req.body ?? {};

    // IMPORTANT: crawler_jobs.type is CHECK-constrained in production. Use an allowed type.
    // We tag the job with parameters.mode='geo' so it can be queried separately from other comprehensive runs.
    const parameters = {
      ...(payload && typeof payload === 'object' ? payload : {}),
      mode: 'geo',
    };

    req.db
      .prepare(
        `
          INSERT INTO crawler_jobs (type, status, profile_id, organization_id, parameters, requested_by)
          VALUES ('comprehensive', 'queued', NULL, NULL, ?, 'admin')
        `,
      )
      .run(JSON.stringify(parameters));

    const job = req.db
      .prepare('SELECT id, type, status, created_at, started_at, completed_at, result_count, error FROM crawler_jobs WHERE rowid = last_insert_rowid()')
      .get();

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
router.get('/db-stats', (req, res) => {
  try {
    const stats = {
      profiles: req.db.prepare('SELECT COUNT(*) as count FROM profiles').get()?.count || 0,
      profile_sections: req.db.prepare('SELECT COUNT(*) as count FROM profile_sections').get()?.count || 0,
      funding_opportunities: req.db.prepare('SELECT COUNT(*) as count FROM funding_opportunities').get()?.count || 0,
      grants: req.db.prepare('SELECT COUNT(*) as count FROM grants').get()?.count || 0,
      organizations: req.db.prepare('SELECT COUNT(*) as count FROM organizations').get()?.count || 0,
    };

    const sampleOpps = req.db.prepare(`
      SELECT title, keywords, categories 
      FROM funding_opportunities 
      WHERE is_active = 1 
      LIMIT 5
    `).all();

    res.json({ success: true, stats, sample_opportunities: sampleOpps });
  } catch (error) {
    console.error('[admin/db-stats] Error:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to get database stats' });
  }
});

// POST /api/admin/seed-opportunities - Seed real funding opportunities
router.post('/seed-opportunities', async (req, res) => {
  try {
    if (!ensureAdminRequest(req, res)) return;
    const { totalLoaded } = seedRealOpportunities(req.db);
    const totalInDb = req.db.prepare('SELECT COUNT(*) as count FROM funding_opportunities').get()?.count || 0;
    res.json({ success: true, message: `Seeded ${totalLoaded} opportunities`, total_in_database: totalInDb, loaded_from_files: totalLoaded });
  } catch (error) {
    console.error('[admin/seed-opportunities] Error:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to seed opportunities' });
  }
});

// POST /api/admin/seed-assistance-directories - Seed state 211 + national assistance directories
router.post('/seed-assistance-directories', async (req, res) => {
  try {
    if (!ensureAdminRequest(req, res)) return;
    const before = req.db.prepare("SELECT COUNT(*) as count FROM funding_opportunities WHERE source IN ('state_211','assistance_network')").get()?.count || 0;
    const result = seedAssistanceDirectories(req.db);
    const after = req.db.prepare("SELECT COUNT(*) as count FROM funding_opportunities WHERE source IN ('state_211','assistance_network')").get()?.count || 0;
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
    if (!ensureAdminRequest(req, res)) return;

    // Import canonical sections
    const { supportedSectionKeys } = await import('../prompts/profileSections.js');

    // Get all profiles
    const profiles = req.db.prepare('SELECT id, display_name FROM profiles').all();

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
    ensureDesignatedProfiles(req.db);
    const profilesCount = req.db.prepare('SELECT COUNT(*) as count FROM profiles').get()?.count || 0;
    const sectionsCount = req.db.prepare('SELECT COUNT(*) as count FROM profile_sections').get()?.count || 0;
    res.json({ success: true, message: 'Profiles synchronized', profiles: profilesCount, total_sections: sectionsCount });
  } catch (error) {
    console.error('[admin/sync-profiles] Error:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to sync profiles' });
  }
});

// POST /api/admin/seed-baseline-profiles
// Upsert the baseline profiles, sections, organizations, and grants from seed/baseline-profiles.json (production-safe).
// Supports seed_key header for authenticated CLI seeding without session auth.
router.post('/seed-baseline-profiles', async (req, res) => {
  try {
    // Allow seeding with seed_key header (for CLI/deployment automation)
    const seedKey = req.headers['x-seed-key'] || req.body?.seed_key;
    const expectedSeedKey = process.env.SEED_KEY || 'grantflow-seed-2026';
    const isSeedKeyValid = seedKey && seedKey === expectedSeedKey;
    
    if (!isSeedKeyValid && !ensureAdminRequest(req, res)) return;

    const seedPath = join(repoRootDir, 'seed', 'baseline-profiles.json');
    if (!fs.existsSync(seedPath)) {
      return res.status(500).json({ success: false, error: `Seed file not found at ${seedPath}` });
    }

    const payload = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
    if (!Array.isArray(payload?.profiles) || !Array.isArray(payload?.sections)) {
      return res.status(400).json({ success: false, error: 'Seed file missing profiles/sections arrays' });
    }

    const before = req.db.prepare('SELECT COUNT(*) as count FROM profiles').get()?.count || 0;

    const upsertProfile = req.db.prepare(`
      INSERT INTO profiles (id, primary_type, display_name, status, tags, avatar_url, organization_id, updated_at)
      VALUES (@id, @primary_type, @display_name, @status, @tags, @avatar_url, @organization_id, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        primary_type = excluded.primary_type,
        display_name = excluded.display_name,
        status = excluded.status,
        tags = excluded.tags,
        avatar_url = excluded.avatar_url,
        organization_id = excluded.organization_id,
        updated_at = CURRENT_TIMESTAMP
    `);

    const upsertSection = req.db.prepare(`
      INSERT INTO profile_sections (profile_id, section_key, data, updated_by, updated_at)
      VALUES (@profile_id, @section_key, @data, 'system-seed', CURRENT_TIMESTAMP)
      ON CONFLICT(profile_id, section_key) DO UPDATE SET
        data = excluded.data,
        updated_by = excluded.updated_by,
        updated_at = CURRENT_TIMESTAMP
    `);

    // Prepare organization upsert if organizations exist in payload
    // Note: only insert core fields that exist in schema
    const upsertOrg = req.db.prepare(`
      INSERT INTO organizations (id, name, email, phone, applicant_type, created_at, updated_at)
      VALUES (@id, @name, @email, @phone, @applicant_type, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        email = excluded.email,
        phone = excluded.phone,
        applicant_type = excluded.applicant_type,
        updated_at = CURRENT_TIMESTAMP
    `);

    const upsertProfileOrg = req.db.prepare(`
      INSERT OR IGNORE INTO profile_organizations (profile_id, organization_id)
      VALUES (?, ?)
    `);

    // Prepare funding opportunities upsert
    const upsertOpp = req.db.prepare(`
      INSERT INTO funding_opportunities (
        id, title, sponsor, description, source, source_id, source_url, 
        application_url, deadline, amount_min, amount_max, amount_description,
        type, categories, keywords, state, is_national, requires_501c3, is_active
      ) VALUES (
        @id, @title, @sponsor, @description, @source, @source_id, @source_url,
        @application_url, @deadline, @amount_min, @amount_max, @amount_description,
        @type, @categories, @keywords, @state, @is_national, @requires_501c3, @is_active
      ) ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        sponsor = excluded.sponsor,
        description = excluded.description,
        is_active = excluded.is_active,
        updated_at = CURRENT_TIMESTAMP
    `);

    // Prepare grants upsert
    const upsertGrant = req.db.prepare(`
      INSERT INTO grants (
        id, organization_id, funding_opportunity_id, title, funder,
        status, match_score, match_reasons, deadline, amount_requested
      ) VALUES (
        @id, @organization_id, @funding_opportunity_id, @title, @funder,
        @status, @match_score, @match_reasons, @deadline, @amount_requested
      ) ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        status = excluded.status,
        match_score = excluded.match_score,
        updated_at = CURRENT_TIMESTAMP
    `);

    const tx = req.db.transaction(() => {
      // 1. Seed organizations first (if present)
      // Allowed applicant_types per production schema CHECK constraint
      const validApplicantTypes = ['individual_need', 'family', 'organization', 'nonprofit', 'small_business', 'student', 'college_student', 'high_school_student', 'medical_assistance', 'government', 'other'];
      
      if (Array.isArray(payload.organizations)) {
        payload.organizations.forEach((org) => {
          // Map 'individual' to 'individual_need' for production schema compatibility
          let applicantType = org.applicant_type ?? 'individual_need';
          if (!validApplicantTypes.includes(applicantType)) {
            applicantType = 'individual_need';
          }
          upsertOrg.run({
            id: org.id,
            name: org.name,
            email: org.email ?? null,
            phone: org.phone ?? null,
            applicant_type: applicantType,
          });
        });
      }

      // 2. Seed funding opportunities (if present)
      if (Array.isArray(payload.funding_opportunities)) {
        payload.funding_opportunities.forEach((opp) => {
          upsertOpp.run({
            id: opp.id,
            title: opp.title,
            sponsor: opp.sponsor ?? null,
            description: opp.description ?? null,
            source: opp.source ?? 'seeded',
            source_id: opp.source_id ?? opp.id,
            source_url: opp.source_url ?? null,
            application_url: opp.application_url ?? null,
            deadline: opp.deadline ?? null,
            amount_min: opp.amount_min ?? null,
            amount_max: opp.amount_max ?? null,
            amount_description: opp.amount_description ?? null,
            type: opp.type ?? 'grant',
            categories: typeof opp.categories === 'string' ? opp.categories : JSON.stringify(opp.categories ?? []),
            keywords: typeof opp.keywords === 'string' ? opp.keywords : JSON.stringify(opp.keywords ?? []),
            state: opp.state ?? null,
            is_national: opp.is_national ? 1 : 0,
            requires_501c3: opp.requires_501c3 ? 1 : 0,
            is_active: opp.is_active !== false ? 1 : 0,
          });
        });
      }

      // 3. Seed profiles
      payload.profiles.forEach((profile) => {
        upsertProfile.run({
          id: profile.id,
          primary_type: profile.primary_type ?? null,
          display_name: profile.display_name,
          status: profile.status ?? 'active',
          tags: typeof profile.tags === 'string' ? profile.tags : JSON.stringify(profile.tags ?? []),
          avatar_url: profile.avatar_url ?? null,
          organization_id: profile.organization_id ?? null,
        });
        linkProfileToAdmin(req.db, profile.id);
      });

      // 4. Seed sections
      payload.sections.forEach((section) => {
        if (!section?.profile_id || !section?.section_key) return;
        const dataStr = typeof section.data === 'string' ? section.data : JSON.stringify(section.data ?? {});
        upsertSection.run({
          profile_id: section.profile_id,
          section_key: section.section_key,
          data: dataStr,
        });
      });

      // 5. Seed profile-organization links
      if (Array.isArray(payload.profile_organizations)) {
        payload.profile_organizations.forEach((link) => {
          upsertProfileOrg.run(link.profile_id, link.organization_id);
        });
      }

      // 6. Seed grants
      if (Array.isArray(payload.grants)) {
        payload.grants.forEach((grant) => {
          upsertGrant.run({
            id: grant.id,
            organization_id: grant.organization_id,
            funding_opportunity_id: grant.funding_opportunity_id,
            title: grant.title,
            funder: grant.funder ?? null,
            status: grant.status ?? 'discovered',
            match_score: grant.match_score ?? null,
            match_reasons: typeof grant.match_reasons === 'string' ? grant.match_reasons : JSON.stringify(grant.match_reasons ?? []),
            deadline: grant.deadline ?? null,
            amount_requested: grant.amount_requested ?? null,
          });
        });
      }

      // 7. Seed documents (if present)
      if (Array.isArray(payload.documents)) {
        const upsertDoc = req.db.prepare(`
          INSERT INTO documents (id, profile_id, name, type, file_url, mime_type, extracted_text, processing_status, status, notes)
          VALUES (@id, @profile_id, @name, @type, @file_url, @mime_type, @extracted_text, @processing_status, @status, @notes)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            extracted_text = excluded.extracted_text,
            processing_status = excluded.processing_status,
            status = excluded.status,
            updated_at = CURRENT_TIMESTAMP
        `);
        
        payload.documents.forEach((doc) => {
          upsertDoc.run({
            id: doc.id,
            profile_id: doc.profile_id,
            name: doc.name,
            type: doc.type ?? 'profile_document',
            file_url: doc.file_url ?? null,
            mime_type: doc.mime_type ?? 'application/pdf',
            extracted_text: doc.extracted_text ?? null,
            processing_status: doc.processing_status ?? 'completed',
            status: doc.status ?? 'active',
            notes: doc.notes ?? null,
          });
        });
      }

      // 8. Seed profile-document links (if present)
      if (Array.isArray(payload.profile_documents)) {
        const upsertProfileDoc = req.db.prepare(`
          INSERT OR IGNORE INTO profile_documents (profile_id, document_id)
          VALUES (?, ?)
        `);
        
        payload.profile_documents.forEach((link) => {
          upsertProfileDoc.run(link.profile_id, link.document_id);
        });
      }
    });

    tx();

    const after = req.db.prepare('SELECT COUNT(*) as count FROM profiles').get()?.count || 0;
    const sectionsCount = req.db.prepare('SELECT COUNT(*) as count FROM profile_sections').get()?.count || 0;
    const orgsCount = req.db.prepare('SELECT COUNT(*) as count FROM organizations').get()?.count || 0;
    const grantsCount = req.db.prepare('SELECT COUNT(*) as count FROM grants').get()?.count || 0;
    const oppsCount = req.db.prepare('SELECT COUNT(*) as count FROM funding_opportunities').get()?.count || 0;
    const docsCount = req.db.prepare('SELECT COUNT(*) as count FROM documents').get()?.count || 0;
    const profileDocsCount = req.db.prepare('SELECT COUNT(*) as count FROM profile_documents').get()?.count || 0;

    res.json({
      success: true,
      message: `Seeded baseline data. Profiles: ${before} → ${after}. Sections: ${sectionsCount}. Orgs: ${orgsCount}. Grants: ${grantsCount}. Docs: ${docsCount}. DocLinks: ${profileDocsCount}.`,
      counts: { 
        profiles_before: before, 
        profiles_after: after, 
        sections: sectionsCount,
        organizations: orgsCount,
        grants: grantsCount,
        opportunities: oppsCount,
        documents: docsCount,
        profile_document_links: profileDocsCount
      },
      seed_profiles: payload.profiles.length,
      seed_sections: payload.sections.length,
      seed_organizations: payload.organizations?.length ?? 0,
      seed_grants: payload.grants?.length ?? 0,
      seed_documents: payload.documents?.length ?? 0,
      seed_profile_documents: payload.profile_documents?.length ?? 0,
    });
  } catch (error) {
    console.error('[admin/seed-baseline-profiles] Error:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to seed baseline profiles' });
  }
});

// POST /api/admin/seed-profile-grants - Seed grants for profiles
router.post('/seed-profile-grants', async (req, res) => {
  try {
    const { excludeProfiles = [] } = req.body || {};
    const profiles = req.db.prepare('SELECT * FROM profiles WHERE status = ?').all('active');
    const opportunities = req.db.prepare(`
      SELECT * FROM funding_opportunities 
      WHERE is_active = 1 
      AND (requires_match = 0 OR requires_match IS NULL)
      LIMIT 500
    `).all();

    let totalGrantsAdded = 0;
    const results = [];

    for (const profile of profiles) {
      const displayName = (profile.display_name || '').toLowerCase();
      if (excludeProfiles.some(excluded => displayName.includes(excluded.toLowerCase()))) {
        results.push({ profile: profile.display_name, status: 'skipped', opportunities_found: 0, grants_added: 0 });
        continue;
      }

      const sections = {};
      const sectionRows = req.db.prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?').all(profile.id);
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
        req.db.prepare(`INSERT INTO organizations (id, name, applicant_type, created_at, updated_at) VALUES (?, ?, 'individual_need', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`).run(orgId, profile.display_name || 'My Organization');
        req.db.prepare('UPDATE profiles SET organization_id = ? WHERE id = ?').run(orgId, profile.id);
      }

      let added = 0;
      for (const { opp, score, matchedFields } of topMatches) {
        const existing = req.db.prepare('SELECT id FROM grants WHERE organization_id = ? AND (funding_opportunity_id = ? OR title = ?)').get(orgId, opp.id, opp.title);
        if (!existing) {
          try {
            req.db.prepare(`
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
    const adminUser = req.db.prepare('SELECT id FROM users WHERE is_admin = 1 LIMIT 1').get();
    if (!adminUser) {
      return res.status(404).json({ success: false, error: 'Admin user not found' });
    }

    const organizations = req.db.prepare('SELECT id FROM organizations').all();
    let linkedCount = 0;

    for (const org of organizations) {
      try {
        const existingLink = req.db.prepare('SELECT 1 FROM user_organizations WHERE user_id = ? AND organization_id = ?').get(adminUser.id, org.id);
        if (!existingLink) {
          req.db.prepare('INSERT INTO user_organizations (user_id, organization_id) VALUES (?, ?)').run(adminUser.id, org.id);
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
    
    db.prepare(`
      INSERT INTO crawler_jobs (
        id, type, status, parameters, requested_by, created_at
      ) VALUES (?, ?, ?, ?, ?, datetime('now'))
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
      .then(result => {
        nationalCrawlJob.status = 'completed'
        nationalCrawlJob.completed_at = new Date().toISOString()
        nationalCrawlJob.result = result
        
        // Update job record
        db.prepare(`
          UPDATE crawler_jobs 
          SET status = 'completed', 
              completed_at = datetime('now'),
              result_count = ?,
              result_meta = ?
          WHERE id = ?
        `).run(result.sources, JSON.stringify(result), jobId)
      })
      .catch(error => {
        nationalCrawlJob.status = 'failed'
        nationalCrawlJob.error = error.message
        
        // Update job record
        db.prepare(`
          UPDATE crawler_jobs 
          SET status = 'failed', 
              completed_at = datetime('now'),
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
    req.db.prepare(`
      UPDATE crawler_jobs 
      SET status = 'cancelled', 
          completed_at = datetime('now')
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
    
    // Get current job status if running
    if (nationalCrawlJob) {
      // Get progress from database
      const progress = db.prepare(`
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
    const lastJob = db.prepare(`
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
    const progress = db.prepare(`
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
    if (!ensureAdminRequest(req, res)) return;
    
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
    
    const result = queryAuditLogs(req.db, {
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
    if (!ensureAdminRequest(req, res)) return;
    
    const days = Math.min(parseInt(req.query.days) || 7, 90);
    const summary = getAuditSummary(req.db, { days });
    
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
    if (!ensureAdminRequest(req, res)) return;
    
    const retentionDays = Math.min(parseInt(req.body.retentionDays) || 90, 365);
    const result = cleanupAuditLogs(req.db, { retentionDays });
    
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
    if (!ensureAdminRequest(req, res)) return;
    
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
    if (!ensureAdminRequest(req, res)) return;
    
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
    if (!ensureAdminRequest(req, res)) return;
    
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
    if (!ensureAdminRequest(req, res)) return;
    
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
    if (!ensureAdminRequest(req, res)) return;
    
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
    if (!ensureAdminRequest(req, res)) return;
    
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
    if (!ensureAdminRequest(req, res)) return;
    
    const result = cleanupExpiredOverrides(req.db);
    
    res.json(result);
  } catch (error) {
    console.error('[admin/feature-flags/cleanup] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
