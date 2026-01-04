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
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
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

    console.log('[Admin Upload] Processing document:', file.originalname);

    // Step 1: Extract text from PDF
    const extractedText = await extractTextFromPDF(file.path);
    if (!extractedText) {
      // Clean up file
      try {
        fs.unlinkSync(file.path);
      } catch (err) {
        console.warn('Failed to remove uploaded file', err);
      }
      return res.status(400).json({ 
        error: 'Unable to extract text from PDF',
        message: 'The PDF appears to be empty or contains only images' 
      });
    }

    console.log('[Admin Upload] Extracted text length:', extractedText.length);

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
    console.log('[Admin Upload] Extracted data:', JSON.stringify(extractedData, null, 2));

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

    console.log('[Admin Upload] Created profile:', profileId);

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

    console.log('[Admin Upload] Created document:', documentId);

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

export default router;
