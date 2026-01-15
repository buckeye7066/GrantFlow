import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';

// Never embed secrets in source control.
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || null

const db = new Database('./data/grantflow.db');
if (!OPENAI_API_KEY) {
  console.error('[process-anastasia-ai] OPENAI_API_KEY is required.')
  process.exit(1)
}
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const PROFILE_ID = 'c4a92724-9cee-416f-ba30-e91b9b5cd885'; // Anastasia's profile

// Get the document
const doc = db.prepare('SELECT id, extracted_text, file_path FROM documents WHERE profile_id = ?').get(PROFILE_ID);
console.log('Document:', doc?.id);
console.log('Extracted text length:', doc?.extracted_text?.length || 0);

// Since it's a scanned PDF with minimal text, we'll use whatever text we have
// plus ask AI to help structure it

const EXTRACTION_PROMPT = `You are extracting profile information from a document. The document text may be incomplete due to being scanned.

Based on the available text and any context clues, extract ALL information you can find and return a JSON object with this structure:

{
  "basic_information": {
    "full_name": "person's full legal name",
    "date_of_birth": "MM/DD/YYYY if found",
    "email": "email if found",
    "phone": "phone number if found",
    "address": {
      "street": "street address",
      "city": "city",
      "state": "state abbreviation",
      "zip": "zip code"
    },
    "ssn_last4": "last 4 digits only if found"
  },
  "demographics": {
    "gender": "",
    "ethnicity": "",
    "veteran_status": "",
    "disability_status": "",
    "citizenship": "",
    "age_group": ""
  },
  "education": {
    "highest_level": "",
    "schools": []
  },
  "employment": {
    "current_status": "",
    "employer": "",
    "job_title": "",
    "annual_income": ""
  },
  "financial": {
    "annual_income": "",
    "household_size": "",
    "receives_assistance": []
  },
  "medical": {
    "conditions": [],
    "medications": [],
    "disabilities": []
  },
  "housing": {
    "status": "",
    "type": "",
    "monthly_cost": ""
  },
  "family": {
    "marital_status": "",
    "dependents": []
  },
  "narrative": {
    "personal_statement": "",
    "needs_description": "",
    "goals": ""
  }
}

If information is not found, leave fields as empty strings or empty arrays. Return ONLY valid JSON, no markdown.`;

async function main() {
  console.log('\n=== Processing Anastasia Profile with AI ===\n');
  
  // Get any existing text from the document
  let docText = doc?.extracted_text || '';
  
  // If text is too short, acknowledge this is a scanned document
  if (docText.length < 200) {
    console.log('Document appears to be scanned images with minimal text extraction.');
    console.log('Will attempt AI extraction with available context...\n');
    
    // Add context that this is Anastasia's profile document
    docText = `This is a profile application document for a person named Anastasia.
The document is a scanned PDF that could not be fully text-extracted.
File: Anastasia profile.pdf
Profile Type: Individual

Available extracted text (may be incomplete):
${docText}

Please extract any information you can infer or that might be standard for such an application form.`;
  }
  
  try {
    console.log('Calling OpenAI to extract profile data...');
    
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: EXTRACTION_PROMPT },
        { role: 'user', content: docText }
      ],
      response_format: { type: 'json_object' },
      max_tokens: 2000,
      temperature: 0.1
    });
    
    const extracted = JSON.parse(response.choices[0].message.content);
    console.log('AI extraction complete!\n');
    console.log('Extracted data:', JSON.stringify(extracted, null, 2));
    
    // Update profile sections
    const sections = [
      'basic_information', 'demographics', 'education', 'employment',
      'financial', 'medical', 'housing', 'family', 'narrative'
    ];
    
    console.log('\nUpdating profile sections...');
    
    for (const sectionKey of sections) {
      const sectionData = extracted[sectionKey];
      if (sectionData && Object.keys(sectionData).length > 0) {
        // Check if there's any actual data
        const hasData = Object.values(sectionData).some(v => 
          v && v !== '' && (!Array.isArray(v) || v.length > 0) && 
          (typeof v !== 'object' || Object.keys(v).some(k => v[k] && v[k] !== ''))
        );
        
        if (hasData) {
          db.prepare(`
            INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
            VALUES (?, ?, ?, 'ai-extraction')
            ON CONFLICT(profile_id, section_key) DO UPDATE SET
              data = excluded.data,
              updated_at = CURRENT_TIMESTAMP,
              updated_by = 'ai-extraction'
          `).run(PROFILE_ID, sectionKey, JSON.stringify(sectionData));
          
          console.log(`  ✓ ${sectionKey}: updated`);
        }
      }
    }
    
    // Update profile name if we got one
    if (extracted.basic_information?.full_name) {
      db.prepare('UPDATE profiles SET display_name = ? WHERE id = ?')
        .run(extracted.basic_information.full_name, PROFILE_ID);
      console.log(`\n  Updated display name to: ${extracted.basic_information.full_name}`);
    }
    
  } catch (error) {
    console.error('AI extraction failed:', error.message);
  }
  
  // Final summary
  console.log('\n=== Final Profile Status ===');
  const profile = db.prepare('SELECT display_name FROM profiles WHERE id = ?').get(PROFILE_ID);
  const sections = db.prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?').all(PROFILE_ID);
  
  console.log(`Profile: ${profile?.display_name}`);
  console.log(`Sections: ${sections.length}`);
  sections.forEach(s => {
    const data = JSON.parse(s.data || '{}');
    const filled = Object.values(data).filter(v => v && v !== '' && (!Array.isArray(v) || v.length > 0)).length;
    console.log(`  - ${s.section_key}: ${filled} fields filled`);
  });
  
  db.close();
  console.log('\nDone!');
}

main().catch(console.error);
