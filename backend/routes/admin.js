import express from 'express';
import crypto from 'crypto';
import multer from 'multer';
import fs from 'fs';
import { promises as fsp } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import pdfParse from 'pdf-parse';
import OpenAI from 'openai';

const router = express.Router();

// Configuration constants
const MAX_TEXT_LENGTH_FOR_AI = 10000; // Maximum characters to send to OpenAI
const AI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini'; // Configurable AI model

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const uploadDir = join(__dirname, '..', 'uploads');

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
    // Check admin access - must match frontend's user.is_admin check
    const user = req.user;
    if (!user || !user.is_admin) {
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

/**
 * Admin endpoint to seed funding opportunities
 * Loads real opportunities from JSON files and inserts them into the database
 */
router.post('/seed-opportunities', async (req, res) => {
  try {
    const dataDir = join(__dirname, '..', 'data', 'crawlers');
    
    // Load all opportunity files
    const files = [
      { path: join(dataDir, 'real_funding_opportunities.json'), type: 'structured' },
      { path: join(dataDir, 'scholarship_opportunities.json'), type: 'array' },
      { path: join(dataDir, 'local_opportunities.json'), type: 'array' },
      { path: join(dataDir, 'item_funding_sources.json'), type: 'array' },
    ];
    
    const allOpportunities = [];
    
    for (const file of files) {
      try {
        const content = await fsp.readFile(file.path, 'utf8');
        const data = JSON.parse(content);
        
        if (file.type === 'structured') {
          // Handle the structured file with multiple categories
          Object.values(data).forEach(category => {
            if (Array.isArray(category)) {
              allOpportunities.push(...category);
            }
          });
        } else if (Array.isArray(data)) {
          allOpportunities.push(...data);
        }
      } catch (e) {
        console.warn(`Failed to load ${file.path}:`, e.message);
      }
    }
    
    console.log(`[admin/seed-opportunities] Loaded ${allOpportunities.length} opportunities`);
    
    // Prepare the upsert statement
    const upsert = req.db.prepare(`
      INSERT INTO funding_opportunities (
        id, source, source_id, title, sponsor, description,
        application_url, source_url, deadline, amount_min, amount_max,
        categories, keywords, eligibility_bullets, match_reasons,
        state, requires_match, requires_501c3, is_active, is_national,
        opportunity_type, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, 1, ?,
        ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        sponsor = excluded.sponsor,
        description = excluded.description,
        application_url = excluded.application_url,
        source_url = excluded.source_url,
        categories = excluded.categories,
        keywords = excluded.keywords,
        eligibility_bullets = excluded.eligibility_bullets,
        updated_at = CURRENT_TIMESTAMP
    `);
    
    let inserted = 0;
    let updated = 0;
    
    const transaction = req.db.transaction(() => {
      for (const opp of allOpportunities) {
        try {
          const id = opp.id || crypto.randomUUID();
          const result = upsert.run(
            id,
            opp.source || 'seeded_real',
            opp.source_id || id,
            opp.title || opp.program_name,
            opp.sponsor || opp.funder,
            opp.description || opp.summary,
            opp.application_url || opp.url,
            opp.url || opp.source_url || opp.application_url, // source_url fallback
            opp.deadline,
            opp.amount_min || opp.award_floor,
            opp.amount_max || opp.award_ceiling,
            JSON.stringify(opp.categories || []),
            JSON.stringify(opp.keywords || []),
            JSON.stringify(opp.eligibility_bullets || []),
            JSON.stringify(opp.match_reasons || []),
            opp.state || (opp.is_national ? 'nationwide' : null),
            opp.requires_match ? 1 : 0,
            opp.requires_501c3 ? 1 : 0,
            opp.is_national ? 1 : 0,
            opp.opportunity_type || 'grant'
          );
          
          if (result.changes > 0) {
            inserted++;
          }
        } catch (e) {
          console.warn(`Failed to insert opportunity ${opp.title}:`, e.message);
        }
      }
    });
    
    transaction();
    
    // Count total opportunities in database
    const total = req.db.prepare('SELECT COUNT(*) as count FROM funding_opportunities WHERE is_active = 1').get();
    
    res.json({
      success: true,
      message: `Seeded ${inserted} opportunities`,
      total_in_database: total.count,
      loaded_from_files: allOpportunities.length
    });
    
  } catch (error) {
    console.error('[admin/seed-opportunities] Error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Admin endpoint to sync designated profiles
 * Ensures all designated profiles are in the database with their sections
 */
router.post('/sync-profiles', async (req, res) => {
  try {
    const { ensureDesignatedProfiles } = await import('../utils/ensureDesignatedProfiles.js');
    ensureDesignatedProfiles(req.db);
    
    const profiles = req.db.prepare('SELECT id, display_name FROM profiles').all();
    const sections = req.db.prepare('SELECT COUNT(*) as count FROM profile_sections').get();
    
    res.json({
      success: true,
      message: 'Profiles synchronized',
      profiles: profiles.length,
      total_sections: sections.count
    });
  } catch (error) {
    console.error('[admin/sync-profiles] Error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Admin endpoint to check profile sections for a specific profile
 */
router.get('/profile-sections/:profileId', (req, res) => {
  try {
    const { profileId } = req.params;
    
    const profile = req.db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId);
    if (!profile) {
      return res.status(404).json({ success: false, error: 'Profile not found' });
    }
    
    const sections = req.db.prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?').all(profileId);
    
    res.json({
      success: true,
      profile: {
        id: profile.id,
        display_name: profile.display_name,
        tags: profile.tags,
        primary_type: profile.primary_type,
      },
      sections: sections.map(s => ({
        key: s.section_key,
        data: JSON.parse(s.data || '{}')
      }))
    });
  } catch (error) {
    console.error('[admin/profile-sections] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Admin endpoint to search opportunities by keyword
 */
router.get('/opportunities-search', (req, res) => {
  try {
    const { keyword } = req.query;
    
    const opportunities = req.db.prepare(`
      SELECT id, title, keywords, categories 
      FROM funding_opportunities 
      WHERE is_active = 1 
        AND (
          LOWER(title) LIKE ? 
          OR LOWER(keywords) LIKE ?
          OR LOWER(categories) LIKE ?
        )
      LIMIT 20
    `).all(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
    
    res.json({
      success: true,
      keyword,
      count: opportunities.length,
      opportunities
    });
  } catch (error) {
    console.error('[admin/opportunities-search] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Admin endpoint to get database stats
 */
router.get('/db-stats', (req, res) => {
  try {
    const stats = {
      profiles: req.db.prepare('SELECT COUNT(*) as c FROM profiles').get().c,
      profile_sections: req.db.prepare('SELECT COUNT(*) as c FROM profile_sections').get().c,
      funding_opportunities: req.db.prepare('SELECT COUNT(*) as c FROM funding_opportunities WHERE is_active = 1').get().c,
      grants: req.db.prepare('SELECT COUNT(*) as c FROM grants').get().c,
      organizations: req.db.prepare('SELECT COUNT(*) as c FROM organizations').get().c,
    };
    
    // Sample funding opportunities
    const sampleOpps = req.db.prepare(`
      SELECT title, keywords, categories 
      FROM funding_opportunities 
      WHERE is_active = 1 
      LIMIT 5
    `).all();
    
    res.json({
      success: true,
      stats,
      sample_opportunities: sampleOpps
    });
  } catch (error) {
    console.error('[admin/db-stats] Error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default router;
