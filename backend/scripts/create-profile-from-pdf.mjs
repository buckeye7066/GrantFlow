import fs from 'fs';
import path from 'path';
import pdfParse from 'pdf-parse';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import OpenAI from 'openai';
import { guardProfileSectionForWrite } from '../utils/guardedProfileSectionWrite.js';

const pdfPath = process.argv[2] || 'G:\\Apps\\grantflow\\GrantFlowb44\\Demo Student profile.pdf';
const dbPath = process.argv[3] || './data/grantflow.db';

const PROFILE_EXTRACTION_PROMPT = `You are extracting structured profile information from a document. Extract all relevant information and return a JSON object with the following structure:

{
  "display_name": "Full name of person or organization",
  "primary_type": "individual" or "nonprofit" or "business" or "government",
  "contact_info": {
    "email": "email address if found",
    "phone": "phone number if found",
    "website": "website if found"
  },
  "address": {
    "street": "street address",
    "city": "city",
    "state": "state abbreviation",
    "zip": "zip code"
  },
  "demographics": {
    "age": "age if mentioned",
    "gender": "gender if mentioned",
    "ethnicity": "ethnicity if mentioned",
    "veteran_status": true/false,
    "disability_status": true/false
  },
  "financial_info": {
    "annual_income": "income if mentioned",
    "household_size": "number of people in household"
  },
  "education": {
    "level": "highest education level",
    "field_of_study": "field if mentioned",
    "institution": "school/university name"
  },
  "employment": {
    "status": "employed/unemployed/student/retired",
    "occupation": "job title or occupation",
    "employer": "employer name if applicable"
  },
  "needs": ["list of needs or assistance types mentioned"],
  "goals": ["list of goals mentioned"],
  "additional_details": "any other relevant information"
}

Only include fields where you find information in the document. Be accurate and conservative.`;

async function main() {
  console.log('Reading PDF:', pdfPath);
  
  if (!fs.existsSync(pdfPath)) {
    console.error('File not found:', pdfPath);
    process.exit(1);
  }
  
  const dataBuffer = fs.readFileSync(pdfPath);
  
  console.log('Parsing PDF...');
  const data = await pdfParse(dataBuffer);
  console.log('Extracted text length:', data.text.length, 'characters');
  console.log('\n--- Extracted Text Preview ---');
  console.log(data.text.slice(0, 1500));
  console.log('--- End Preview ---\n');
  
  // Use OpenAI to extract structured data
  let extractedData = {};
  const openaiKey = process.env.OPENAI_API_KEY;
  
  if (openaiKey) {
    console.log('Using OpenAI to extract structured profile data...');
    const openai = new OpenAI({ apiKey: openaiKey });
    
    try {
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: PROFILE_EXTRACTION_PROMPT },
          { role: 'user', content: `Extract profile information from this document:\n\n${data.text.slice(0, 10000)}` }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.1,
      });
      
      extractedData = JSON.parse(completion.choices[0]?.message?.content || '{}');
      console.log('\n--- AI Extracted Data ---');
      console.log(JSON.stringify(extractedData, null, 2));
      console.log('--- End Extracted Data ---\n');
    } catch (error) {
      console.error('OpenAI extraction failed:', error.message);
    }
  } else {
    console.log('OPENAI_API_KEY not set, skipping AI extraction');
  }
  
  // Create profile in database
  console.log('Opening database:', dbPath);
  const db = new Database(dbPath);
  
  const profileId = crypto.randomUUID();
  const displayName = extractedData.display_name || 'Demo Student Profile';
  const primaryType = extractedData.primary_type || 'individual';
  
  console.log('Creating profile:', displayName, '(', profileId, ')');
  
  db.prepare(`
    INSERT INTO profiles (id, display_name, primary_type, status, tags, created_by)
    VALUES (?, ?, ?, 'draft', '[]', 'admin')
  `).run(profileId, displayName, primaryType);
  
  // Store document
  const documentId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO documents (id, profile_id, name, type, extracted_text, processing_status, notes)
    VALUES (?, ?, ?, 'profile_document', ?, 'completed', 'Uploaded for profile creation')
  `).run(documentId, profileId, path.basename(pdfPath), data.text);
  
  // Link document to profile
  db.prepare('INSERT OR IGNORE INTO profile_documents (profile_id, document_id) VALUES (?, ?)').run(profileId, documentId);
  
  // Create profile sections from extracted data
  const sectionInsert = db.prepare(`
    INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
    VALUES (?, ?, ?, 'admin-import')
    ON CONFLICT(profile_id, section_key) DO UPDATE SET
      data = excluded.data,
      updated_at = CURRENT_TIMESTAMP,
      updated_by = excluded.updated_by
  `);
  
  // Basic information section
  if (extractedData.contact_info || extractedData.address) {
    const basicInfo = {
      full_name: extractedData.display_name || '',
      email: extractedData.contact_info?.email || '',
      phone: extractedData.contact_info?.phone || '',
      website: extractedData.contact_info?.website || '',
      address: extractedData.address ? 
        `${extractedData.address.street || ''}, ${extractedData.address.city || ''}, ${extractedData.address.state || ''} ${extractedData.address.zip || ''}`.trim().replace(/^,\s*/, '') : '',
    };
    const guarded = await guardProfileSectionForWrite(db, profileId, 'basic_information', basicInfo);
    sectionInsert.run(profileId, 'basic_information', JSON.stringify(guarded.data));
    console.log('Added section: basic_information');
  }
  
  // Demographics section
  if (extractedData.demographics) {
    const guarded = await guardProfileSectionForWrite(db, profileId, 'demographics', extractedData.demographics);
    sectionInsert.run(profileId, 'demographics', JSON.stringify(guarded.data));
    console.log('Added section: demographics');
  }
  
  // Financial section
  if (extractedData.financial_info) {
    const guarded = await guardProfileSectionForWrite(db, profileId, 'financial_information', extractedData.financial_info);
    sectionInsert.run(profileId, 'financial_information', JSON.stringify(guarded.data));
    console.log('Added section: financial_information');
  }
  
  // Education/occupation section
  if (extractedData.education || extractedData.employment) {
    const occupation = {
      ...extractedData.education,
      ...extractedData.employment,
    };
    const guarded = await guardProfileSectionForWrite(db, profileId, 'occupation', occupation);
    sectionInsert.run(profileId, 'occupation', JSON.stringify(guarded.data));
    console.log('Added section: occupation');
  }
  
  // Narrative section
  if (extractedData.needs || extractedData.goals || extractedData.additional_details) {
    const narrative = {
      needs: extractedData.needs || [],
      goals: extractedData.goals || [],
      additional_details: extractedData.additional_details || '',
    };
    const guarded = await guardProfileSectionForWrite(db, profileId, 'narrative', narrative);
    sectionInsert.run(profileId, 'narrative', JSON.stringify(guarded.data));
    console.log('Added section: narrative');
  }
  
  console.log('\n=== Profile Created Successfully ===');
  console.log('Profile ID:', profileId);
  console.log('Display Name:', displayName);
  console.log('Document ID:', documentId);
  console.log('View at: http://localhost:5173/grantflow/profile/', profileId);
  
  db.close();
}

main().catch(console.error);
