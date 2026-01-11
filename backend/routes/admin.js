import express from 'express';
import crypto from 'crypto';
import multer from 'multer';
import fs from 'fs';
import { promises as fsp } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import pdfParse from 'pdf-parse';
import OpenAI from 'openai';
import { seedRealOpportunities } from '../utils/seedRealOpportunities.js';
import { ensureDesignatedProfiles } from '../utils/ensureDesignatedProfiles.js';
import { buildProfileSignals, calculateMatchScore } from '../services/profileHelpers.js';
import { getSystemDiagnostics } from '../services/diagnosticsService.js';
import { linkProfileToAdmin } from '../utils/adminProfileLinks.js';

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
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY environment variable is not set');
  }
  return new OpenAI({ apiKey });
}

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

        // Step 5: Store extracted fields in profile sections (if relevant)
      // For now, we'll just return them to the frontend
      // In a more complete implementation, you could map these to profile_sections table

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
          SELECT id, type, status, created_at, completed_at, result_count, error
          FROM crawler_jobs
          WHERE type = 'geo_crawl'
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
    const jobId = crypto.randomUUID();
    req.db
      .prepare(
        `
          INSERT INTO crawler_jobs (id, type, status, parameters, requested_by, created_at)
          VALUES (?, 'geo_crawl', 'queued', ?, ?, datetime('now'))
        `,
      )
      .run(jobId, JSON.stringify(payload), req.user?.id || 'admin');
    res.status(201).json({ success: true, job: { id: jobId, status: 'queued', parameters: payload } });
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
    const { totalLoaded } = seedRealOpportunities(req.db);
    const totalInDb = req.db.prepare('SELECT COUNT(*) as count FROM funding_opportunities').get()?.count || 0;
    res.json({ success: true, message: `Seeded ${totalLoaded} opportunities`, total_in_database: totalInDb, loaded_from_files: totalLoaded });
  } catch (error) {
    console.error('[admin/seed-opportunities] Error:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to seed opportunities' });
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
// Upsert the baseline 15 profiles + their sections from seed/baseline-profiles.json (production-safe).
router.post('/seed-baseline-profiles', async (req, res) => {
  try {
    if (!ensureAdminRequest(req, res)) return;

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
      INSERT INTO profiles (id, primary_type, display_name, status, tags, avatar_url, updated_at)
      VALUES (@id, @primary_type, @display_name, @status, @tags, @avatar_url, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        primary_type = excluded.primary_type,
        display_name = excluded.display_name,
        status = excluded.status,
        tags = excluded.tags,
        avatar_url = excluded.avatar_url,
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

    const tx = req.db.transaction(() => {
      payload.profiles.forEach((profile) => {
        upsertProfile.run({
          id: profile.id,
          primary_type: profile.primary_type ?? null,
          display_name: profile.display_name,
          status: profile.status ?? 'active',
          tags: JSON.stringify(profile.tags ?? []),
          avatar_url: profile.avatar_url ?? null,
        });
        linkProfileToAdmin(req.db, profile.id);
      });

      payload.sections.forEach((section) => {
        if (!section?.profile_id || !section?.section_key) return;
        upsertSection.run({
          profile_id: section.profile_id,
          section_key: section.section_key,
          data: JSON.stringify(section.data ?? {}),
        });
      });
    });

    tx();

    const after = req.db.prepare('SELECT COUNT(*) as count FROM profiles').get()?.count || 0;
    const sectionsCount = req.db.prepare('SELECT COUNT(*) as count FROM profile_sections').get()?.count || 0;

    res.json({
      success: true,
      message: `Seeded baseline profiles (upsert). Profiles: ${before} → ${after}. Sections: ${sectionsCount}.`,
      counts: { profiles_before: before, profiles_after: after, sections: sectionsCount },
      seed_profiles: payload.profiles.length,
      seed_sections: payload.sections.length,
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

export default router;
