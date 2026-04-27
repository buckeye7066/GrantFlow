import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { guardProfileSectionForWrite } from '../utils/guardedProfileSectionWrite.js';
import crypto from 'crypto';
import pdfParse from 'pdf-parse';
import OpenAI from 'openai';

// Use system environment variable for API key
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const db = new Database('./data/grantflow.db');
const pdfPath = 'G:\\Apps\\grantflow\\GrantFlowb44\\Anastasia profile.pdf';

// Profile extraction prompt
const EXTRACTION_PROMPT = `You are extracting profile information from a document. Extract ALL information you can find and return a JSON object with this structure:

{
  "basic_information": {
    "full_name": "person's full name",
    "date_of_birth": "DOB if found",
    "email": "email if found",
    "phone": "phone if found",
    "address": {
      "street": "",
      "city": "",
      "state": "",
      "zip": ""
    },
    "ssn_last4": "last 4 of SSN if found (for verification only)"
  },
  "demographics": {
    "gender": "",
    "ethnicity": "",
    "veteran_status": "",
    "disability_status": "",
    "citizenship": ""
  },
  "education": {
    "highest_level": "",
    "schools": [
      {
        "name": "",
        "degree": "",
        "field": "",
        "graduation_year": ""
      }
    ]
  },
  "employment": {
    "current_status": "",
    "employer": "",
    "job_title": "",
    "income": "",
    "employment_history": []
  },
  "financial": {
    "annual_income": "",
    "household_size": "",
    "assets": "",
    "debts": "",
    "receives_assistance": []
  },
  "medical": {
    "conditions": [],
    "medications": [],
    "insurance": "",
    "disabilities": []
  },
  "housing": {
    "status": "",
    "type": "",
    "monthly_cost": ""
  },
  "family": {
    "marital_status": "",
    "dependents": [],
    "emergency_contact": {}
  },
  "narrative": {
    "personal_statement": "",
    "needs_description": "",
    "goals": ""
  }
}

Extract EVERYTHING you can find from the document. If information is not found, leave the field empty string or empty array. Return ONLY valid JSON.`;

async function main() {
  console.log('=== Fixing Anastasia Profile ===\n');
  
  // Step 1: Clean up duplicate Anastasia profiles
  console.log('Step 1: Cleaning up duplicates...');
  const anastasiaProfiles = db.prepare(`
    SELECT id, display_name, created_at FROM profiles 
    WHERE display_name LIKE '%Anastasia%'
    ORDER BY created_at DESC
  `).all();
  
  console.log(`Found ${anastasiaProfiles.length} Anastasia profiles`);
  
  // Keep only the most recent one named "Anastasia" (not "Anastasia Profile")
  let keepProfile = anastasiaProfiles.find(p => p.display_name === 'Anastasia');
  if (!keepProfile) {
    keepProfile = anastasiaProfiles[0]; // Keep most recent if no exact match
  }
  
  // Delete the others
  const deleteIds = anastasiaProfiles.filter(p => p.id !== keepProfile.id).map(p => p.id);
  if (deleteIds.length > 0) {
    for (const id of deleteIds) {
      db.prepare('DELETE FROM profile_sections WHERE profile_id = ?').run(id);
      db.prepare('DELETE FROM documents WHERE profile_id = ?').run(id);
      db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
      console.log(`  Deleted duplicate: ${id}`);
    }
  }
  
  const profileId = keepProfile.id;
  console.log(`  Keeping profile: ${profileId} (${keepProfile.display_name})\n`);
  
  // Step 2: Read and parse the PDF
  console.log('Step 2: Reading PDF...');
  const pdfBuffer = fs.readFileSync(pdfPath);
  console.log(`  PDF size: ${(pdfBuffer.length / 1024 / 1024).toFixed(2)} MB`);
  
  let extractedText = '';
  try {
    const pdfData = await pdfParse(pdfBuffer);
    extractedText = pdfData.text;
    console.log(`  Extracted ${extractedText.length} characters via pdf-parse`);
  } catch (error) {
    console.log(`  pdf-parse failed: ${error.message}`);
  }
  
  // Step 3: Copy PDF to uploads folder
  console.log('\nStep 3: Copying PDF to uploads...');
  const uploadsDir = './uploads';
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }
  
  const docId = crypto.randomUUID();
  const destFilename = `${docId}-Anastasia-profile.pdf`;
  const destPath = path.join(uploadsDir, destFilename);
  fs.copyFileSync(pdfPath, destPath);
  console.log(`  Copied to: ${destPath}`);
  
  // Step 4: Store document in database
  console.log('\nStep 4: Storing document record...');
  
  // Delete old documents for this profile
  db.prepare('DELETE FROM documents WHERE profile_id = ?').run(profileId);
  
  // Do not set documents.status on insert; rely on DB defaults.
  db.prepare(`
    INSERT INTO documents (id, profile_id, name, type, file_path, file_url, file_size, mime_type, extracted_text, processing_status, notes)
    VALUES (?, ?, ?, 'profile_document', ?, ?, ?, 'application/pdf', ?, 'completed', 'Original application document')
  `).run(
    docId,
    profileId,
    'Anastasia profile.pdf',
    destPath,
    `/uploads/${destFilename}`,
    pdfBuffer.length,
    extractedText
  );
  console.log(`  Document ID: ${docId}`);
  
  // Step 5: Use OpenAI to extract structured data
  console.log('\nStep 5: Extracting structured data with AI...');
  
  if (!OPENAI_API_KEY) {
    console.log('  WARNING: No OPENAI_API_KEY found. Skipping AI extraction.');
    console.log('  Profile will have basic info only.');
  } else {
    try {
      const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
      
      // If we have text, use it; otherwise try to describe what we need
      let prompt = EXTRACTION_PROMPT;
      let content = extractedText.length > 100 
        ? `Document text:\n\n${extractedText.slice(0, 50000)}` 
        : 'The PDF appears to be image-based. Please extract any information you can identify.';
      
      console.log('  Calling OpenAI...');
      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content }
        ],
        response_format: { type: 'json_object' },
        max_tokens: 4000
      });
      
      const extracted = JSON.parse(response.choices[0].message.content);
      console.log('  AI extraction successful!');
      
      // Step 6: Store extracted data in profile sections
      console.log('\nStep 6: Storing profile sections...');
      
      const sections = [
        'basic_information', 'demographics', 'education', 'employment',
        'financial', 'medical', 'housing', 'family', 'narrative'
      ];
      
      // Delete existing sections
      db.prepare('DELETE FROM profile_sections WHERE profile_id = ?').run(profileId);
      
      const insertSection = db.prepare(`
        INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
        VALUES (?, ?, ?, 'system-document-parse')
      `);
      
      for (const sectionKey of sections) {
        const sectionData = extracted[sectionKey] || {};
        const guarded = await guardProfileSectionForWrite(db, profileId, sectionKey, sectionData);
        insertSection.run(profileId, sectionKey, JSON.stringify(guarded.data));
        const hasData = Object.values(sectionData).some(v => v && v !== '' && (!Array.isArray(v) || v.length > 0));
        console.log(`  - ${sectionKey}: ${hasData ? 'HAS DATA' : 'empty'}`);
      }
      
      // Update profile display name if we got a better one
      if (extracted.basic_information?.full_name) {
        db.prepare('UPDATE profiles SET display_name = ? WHERE id = ?')
          .run(extracted.basic_information.full_name, profileId);
        console.log(`\n  Updated display name to: ${extracted.basic_information.full_name}`);
      }
      
    } catch (error) {
      console.error('  AI extraction failed:', error.message);
    }
  }
  
  // Final summary
  console.log('\n=== DONE ===');
  const finalProfile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId);
  const finalSections = db.prepare('SELECT section_key FROM profile_sections WHERE profile_id = ?').all(profileId);
  const finalDoc = db.prepare('SELECT id, name FROM documents WHERE profile_id = ?').get(profileId);
  
  console.log(`Profile: ${finalProfile.display_name} (${profileId})`);
  console.log(`Sections: ${finalSections.map(s => s.section_key).join(', ')}`);
  console.log(`Document: ${finalDoc?.name || 'none'}`);
  
  db.close();
}

main().catch(console.error);
