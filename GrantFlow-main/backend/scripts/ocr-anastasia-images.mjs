import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import Database from 'better-sqlite3';
import Anthropic from '@anthropic-ai/sdk';

const CLAUDE_API_KEY = "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";
const PDF_PATH = "G:\\Apps\\grantflow\\GrantFlowb44\\Anastasia profile.pdf";
const TEMP_DIR = "./temp_images";

const db = new Database('./data/grantflow.db');
const anthropic = new Anthropic({ apiKey: CLAUDE_API_KEY });

async function main() {
  console.log('=== OCR Anastasia Profile with Image Conversion ===\n');
  
  // Create temp directory
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }
  
  // Convert PDF to PNG images using pdftoppm
  console.log('Converting PDF to images using pdftoppm...');
  
  try {
    // Convert first 15 pages to PNG (lower resolution for faster processing)
    const cmd = `pdftoppm -png -r 150 -l 15 "${PDF_PATH}" "${TEMP_DIR}/page"`;
    console.log(`Running: ${cmd}`);
    execSync(cmd, { stdio: 'inherit' });
  } catch (error) {
    console.error('pdftoppm error:', error.message);
    // Try finding pdftoppm in common locations
    const possiblePaths = [
      'C:\\Program Files\\poppler-24.08.0\\Library\\bin\\pdftoppm.exe',
      'C:\\ProgramData\\chocolatey\\bin\\pdftoppm.exe'
    ];
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        console.log(`Found pdftoppm at: ${p}`);
        const cmd = `"${p}" -png -r 150 -l 15 "${PDF_PATH}" "${TEMP_DIR}/page"`;
        execSync(cmd, { stdio: 'inherit' });
        break;
      }
    }
  }
  
  // Get list of generated images
  const imageFiles = fs.readdirSync(TEMP_DIR)
    .filter(f => f.endsWith('.png'))
    .sort()
    .slice(0, 10); // Process first 10 pages
  
  console.log(`\nGenerated ${imageFiles.length} images`);
  
  if (imageFiles.length === 0) {
    console.error('No images generated! Check pdftoppm installation.');
    return;
  }
  
  // OCR each image
  let allText = '';
  
  for (let i = 0; i < imageFiles.length; i++) {
    const imgPath = path.join(TEMP_DIR, imageFiles[i]);
    const imgBuffer = fs.readFileSync(imgPath);
    const base64 = imgBuffer.toString('base64');
    
    process.stdout.write(`  Processing ${imageFiles[i]}...`);
    
    try {
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: base64
                }
              },
              {
                type: 'text',
                text: 'Extract ALL text from this scanned form page. Include every field label, value, checkbox status (checked/unchecked), handwritten text, and printed text. Preserve structure and formatting. Be thorough.'
              }
            ]
          }
        ]
      });
      
      const pageText = response.content[0].text;
      allText += `\n\n=== ${imageFiles[i]} ===\n${pageText}`;
      console.log(` ✓ (${pageText.length} chars)`);
      
    } catch (error) {
      console.log(` ✗ ${error.message}`);
    }
    
    // Small delay
    await new Promise(r => setTimeout(r, 300));
  }
  
  console.log(`\n\nTotal OCR text: ${allText.length} characters`);
  console.log('\n--- RAW OCR TEXT PREVIEW ---');
  console.log(allText.substring(0, 3000));
  console.log('--- END PREVIEW ---\n');
  
  // Save raw OCR text
  fs.writeFileSync('./temp_images/ocr_raw.txt', allText);
  console.log('Saved raw OCR to temp_images/ocr_raw.txt');
  
  // Extract structured data
  console.log('\nExtracting structured data...');
  
  const extractionPrompt = `Based on this OCR text from a grant application form for someone named Anastasia, extract all personal information into JSON:

${allText}

Return this exact JSON structure with actual values found:
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

Fill in values from the OCR. Return ONLY valid JSON.`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      messages: [{ role: 'user', content: extractionPrompt }]
    });
    
    const content = response.content[0].text;
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    const extractedData = JSON.parse(jsonMatch ? jsonMatch[0] : content);
    
    console.log('\nExtracted data:');
    console.log(JSON.stringify(extractedData, null, 2));
    
    // Update Anastasia profile
    const profile = db.prepare("SELECT id FROM profiles WHERE display_name LIKE '%Anastasia%'").get();
    if (profile) {
      console.log(`\nUpdating profile ${profile.id}...`);
      
      for (const [sectionKey, sectionData] of Object.entries(extractedData)) {
        if (sectionData && typeof sectionData === 'object') {
          const existing = db.prepare('SELECT data FROM profile_sections WHERE profile_id = ? AND section_key = ?').get(profile.id, sectionKey);
          let currentData = {};
          try { currentData = existing?.data ? JSON.parse(existing.data) : {}; } catch(e) {}
          
          // Merge
          for (const [key, value] of Object.entries(sectionData)) {
            if (value && value !== '' && (!Array.isArray(value) || value.length > 0)) {
              currentData[key] = typeof value === 'object' && !Array.isArray(value) 
                ? { ...(currentData[key] || {}), ...value }
                : value;
            }
          }
          
          db.prepare(`
            INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
            VALUES (?, ?, ?, 'ocr-extraction')
            ON CONFLICT(profile_id, section_key) DO UPDATE SET
              data = excluded.data, updated_at = CURRENT_TIMESTAMP
          `).run(profile.id, sectionKey, JSON.stringify(currentData));
          
          console.log(`  ✓ ${sectionKey}`);
        }
      }
      
      // Update display name if found
      if (extractedData.basic_information?.full_name) {
        const name = extractedData.basic_information.full_name;
        if (name && name.trim() && name !== 'Anastasia') {
          db.prepare('UPDATE profiles SET display_name = ? WHERE id = ?').run(name, profile.id);
          console.log(`  Updated name: ${name}`);
        }
      }
      
      // Save OCR text to document
      const doc = db.prepare('SELECT id FROM documents WHERE profile_id = ?').get(profile.id);
      if (doc) {
        db.prepare('UPDATE documents SET extracted_text = ? WHERE id = ?').run(allText, doc.id);
        console.log('  Saved OCR text to document');
      }
    }
    
  } catch (error) {
    console.error('Extraction error:', error.message);
  }
  
  // Cleanup temp images
  console.log('\nCleaning up temp images...');
  for (const f of fs.readdirSync(TEMP_DIR)) {
    if (f.endsWith('.png')) {
      fs.unlinkSync(path.join(TEMP_DIR, f));
    }
  }
  
  // Final status
  console.log('\n=== FINAL PROFILE STATUS ===');
  const finalProfile = db.prepare("SELECT id, display_name FROM profiles WHERE display_name LIKE '%Anastasia%'").get();
  if (finalProfile) {
    console.log(`Profile: ${finalProfile.display_name}`);
    const sections = db.prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?').all(finalProfile.id);
    for (const s of sections) {
      const data = JSON.parse(s.data || '{}');
      const filled = Object.values(data).filter(v => v && v !== '' && (!Array.isArray(v) || v.length > 0)).length;
      console.log(`  - ${s.section_key}: ${filled} fields`);
    }
  }
  
  db.close();
  console.log('\n✓ DONE!');
}

main();
