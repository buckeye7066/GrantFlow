import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import Anthropic from '@anthropic-ai/sdk';

const CLAUDE_API_KEY = process.env.ANTHROPIC_API_KEY || null
const PDF_PATH = process.env.PDF_PATH || process.argv[2] || null

if (!CLAUDE_API_KEY) {
  console.error('[ocr-anastasia-claude] ANTHROPIC_API_KEY is required.')
  process.exit(1)
}
if (!PDF_PATH) {
  console.error('[ocr-anastasia-claude] PDF_PATH is required. Provide via env PDF_PATH or first CLI argument.')
  process.exit(1)
}

const db = new Database('./data/grantflow.db');

async function main() {
  console.log('=== OCR Anastasia Profile with Claude Vision ===\n');
  
  // Read PDF as base64
  const pdfBuffer = fs.readFileSync(PDF_PATH);
  const pdfBase64 = pdfBuffer.toString('base64');
  
  console.log(`PDF size: ${(pdfBuffer.length / 1024 / 1024).toFixed(2)} MB`);
  console.log('Sending to Claude API for OCR...\n');
  
  const anthropic = new Anthropic({ apiKey: CLAUDE_API_KEY });
  
  const extractionPrompt = `You are analyzing a scanned grant application profile document. 
Extract ALL personal information you can see from the document and return it as JSON.

The document contains information about a person named Anastasia. Look for:
- Full legal name
- Date of birth
- Social Security Number (last 4 digits only)
- Address (street, city, state, zip)
- Phone number
- Email address
- Gender/Sex
- Ethnicity/Race
- Veteran status
- Disability status
- Citizenship status
- Education history
- Employment status and history
- Income information
- Household size
- Public assistance received
- Medical conditions
- Housing situation
- Family/dependents
- Personal statement/goals/needs

Return a JSON object with this structure:
{
  "basic_information": {
    "full_name": "",
    "date_of_birth": "",
    "ssn_last4": "",
    "email": "",
    "phone": "",
    "address": { "street": "", "city": "", "state": "", "zip": "" }
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

IMPORTANT: Extract ACTUAL data from the document. Fill in real values you see. Leave empty string "" for fields you cannot find.
Return ONLY valid JSON, no other text.`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: pdfBase64
              }
            },
            {
              type: 'text',
              text: extractionPrompt
            }
          ]
        }
      ]
    });
    
    const content = response.content[0].text;
    console.log('Claude response received!\n');
    
    // Parse the JSON from Claude's response
    let extractedData;
    try {
      // Try to extract JSON from the response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        extractedData = JSON.parse(jsonMatch[0]);
      } else {
        extractedData = JSON.parse(content);
      }
    } catch (parseError) {
      console.error('Failed to parse JSON:', parseError.message);
      console.log('Raw response:', content);
      return;
    }
    
    console.log('Extracted data:', JSON.stringify(extractedData, null, 2));
    
    // Find Anastasia profile
    const profile = db.prepare("SELECT id, display_name FROM profiles WHERE display_name LIKE '%Anastasia%'").get();
    if (!profile) {
      console.error('Anastasia profile not found!');
      return;
    }
    
    console.log(`\nUpdating profile: ${profile.display_name} (${profile.id})`);
    
    // Update each section
    const sections = ['basic_information', 'demographics', 'education', 'employment', 'financial', 'medical', 'housing', 'family', 'narrative'];
    
    for (const sectionKey of sections) {
      if (extractedData[sectionKey] && Object.keys(extractedData[sectionKey]).length > 0) {
        // Get existing data
        const existing = db.prepare('SELECT data FROM profile_sections WHERE profile_id = ? AND section_key = ?').get(profile.id, sectionKey);
        let currentData = {};
        try {
          currentData = existing?.data ? JSON.parse(existing.data) : {};
        } catch (e) {}
        
        // Merge new data (only non-empty values)
        const newData = extractedData[sectionKey];
        for (const [key, value] of Object.entries(newData)) {
          if (value && value !== '' && (!Array.isArray(value) || value.length > 0)) {
            if (typeof value === 'object' && !Array.isArray(value)) {
              currentData[key] = { ...(currentData[key] || {}), ...value };
            } else {
              currentData[key] = value;
            }
          }
        }
        
        // Upsert section
        db.prepare(`
          INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
          VALUES (?, ?, ?, 'claude-ocr')
          ON CONFLICT(profile_id, section_key) DO UPDATE SET
            data = excluded.data,
            updated_at = CURRENT_TIMESTAMP,
            updated_by = excluded.updated_by
        `).run(profile.id, sectionKey, JSON.stringify(currentData));
        
        const filledFields = Object.entries(currentData).filter(([k, v]) => v && v !== '' && (!Array.isArray(v) || v.length > 0)).length;
        console.log(`  ✓ ${sectionKey}: ${filledFields} fields`);
      }
    }
    
    // Update display name if we got a full name
    if (extractedData.basic_information?.full_name) {
      const fullName = extractedData.basic_information.full_name;
      if (fullName && fullName.trim() && fullName !== 'Anastasia') {
        db.prepare('UPDATE profiles SET display_name = ? WHERE id = ?').run(fullName, profile.id);
        console.log(`\n  Updated display name to: ${fullName}`);
      }
    }
    
    // Final summary
    console.log('\n=== Final Profile Status ===');
    const finalProfile = db.prepare('SELECT display_name FROM profiles WHERE id = ?').get(profile.id);
    console.log(`Profile: ${finalProfile.display_name}`);
    
    const allSections = db.prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?').all(profile.id);
    console.log(`Sections: ${allSections.length}`);
    for (const section of allSections) {
      let data = {};
      try { data = JSON.parse(section.data); } catch (e) {}
      const filledFields = Object.entries(data).filter(([k, v]) => v && v !== '' && (!Array.isArray(v) || v.length > 0)).length;
      console.log(`  - ${section.section_key}: ${filledFields} fields filled`);
    }
    
  } catch (error) {
    console.error('Claude API error:', error.message);
    if (error.status === 413) {
      console.log('\nPDF too large for Claude. Will try page-by-page approach...');
    }
  }
  
  db.close();
  console.log('\nDone!');
}

main();
