import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import Anthropic from '@anthropic-ai/sdk';
import { PDFDocument } from 'pdf-lib';

const CLAUDE_API_KEY = process.env.ANTHROPIC_API_KEY || null
const PDF_PATH = process.env.PDF_PATH || process.argv[2] || null

if (!CLAUDE_API_KEY) {
  console.error('[ocr-anastasia-pages] ANTHROPIC_API_KEY is required.')
  process.exit(1)
}
if (!PDF_PATH) {
  console.error('[ocr-anastasia-pages] PDF_PATH is required. Provide via env PDF_PATH or first CLI argument.')
  process.exit(1)
}

const db = new Database('./data/grantflow.db');
const anthropic = new Anthropic({ apiKey: CLAUDE_API_KEY });

async function extractPageAsPdf(pdfDoc, pageIndex) {
  const newPdf = await PDFDocument.create();
  const [page] = await newPdf.copyPages(pdfDoc, [pageIndex]);
  newPdf.addPage(page);
  return await newPdf.save();
}

async function ocrPage(pageBuffer, pageNum) {
  const base64 = Buffer.from(pageBuffer).toString('base64');
  
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: base64
              }
            },
            {
              type: 'text',
              text: `Extract ALL text from this scanned document page. Include every field, label, checkbox, and handwritten or typed text you can see. Format as plain text preserving the structure. This is page ${pageNum} of a grant application form.`
            }
          ]
        }
      ]
    });
    
    return response.content[0].text;
  } catch (error) {
    console.error(`  Page ${pageNum} error:`, error.message);
    return '';
  }
}

async function main() {
  console.log('=== OCR Anastasia Profile - Page by Page ===\n');
  
  const pdfBuffer = fs.readFileSync(PDF_PATH);
  console.log(`PDF size: ${(pdfBuffer.length / 1024 / 1024).toFixed(2)} MB`);
  
  const pdfDoc = await PDFDocument.load(pdfBuffer);
  const pageCount = pdfDoc.getPageCount();
  console.log(`Total pages: ${pageCount}`);
  
  // Process first 10 pages (most application info is at the start)
  const pagesToProcess = Math.min(pageCount, 10);
  console.log(`Processing first ${pagesToProcess} pages...\n`);
  
  let allText = '';
  
  for (let i = 0; i < pagesToProcess; i++) {
    process.stdout.write(`  Processing page ${i + 1}/${pagesToProcess}...`);
    
    const pageBuffer = await extractPageAsPdf(pdfDoc, i);
    const pageText = await ocrPage(pageBuffer, i + 1);
    
    if (pageText) {
      allText += `\n\n=== PAGE ${i + 1} ===\n${pageText}`;
      console.log(` ✓ (${pageText.length} chars)`);
    } else {
      console.log(' (empty)');
    }
    
    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 500));
  }
  
  console.log(`\nTotal extracted text: ${allText.length} characters`);
  
  // Now send all text to Claude for structured extraction
  console.log('\nExtracting structured data from OCR text...');
  
  const extractionPrompt = `Based on this OCR text from a grant application form, extract all personal information into this JSON structure. Fill in actual values found in the text:

${allText}

Return JSON:
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

IMPORTANT: Use actual values from the OCR text. Return ONLY valid JSON.`;

  try {
    const structuredResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      messages: [{ role: 'user', content: extractionPrompt }]
    });
    
    const content = structuredResponse.content[0].text;
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    const extractedData = JSON.parse(jsonMatch ? jsonMatch[0] : content);
    
    console.log('\nExtracted data:', JSON.stringify(extractedData, null, 2));
    
    // Update Anastasia profile
    const profile = db.prepare("SELECT id, display_name FROM profiles WHERE display_name LIKE '%Anastasia%'").get();
    if (!profile) {
      console.error('Anastasia profile not found!');
      return;
    }
    
    console.log(`\nUpdating profile: ${profile.display_name}`);
    
    // Update sections
    for (const [sectionKey, sectionData] of Object.entries(extractedData)) {
      if (sectionData && typeof sectionData === 'object') {
        const existing = db.prepare('SELECT data FROM profile_sections WHERE profile_id = ? AND section_key = ?').get(profile.id, sectionKey);
        let currentData = existing?.data ? JSON.parse(existing.data) : {};
        
        // Deep merge
        for (const [key, value] of Object.entries(sectionData)) {
          if (value && value !== '' && (!Array.isArray(value) || value.length > 0)) {
            currentData[key] = typeof value === 'object' && !Array.isArray(value) 
              ? { ...(currentData[key] || {}), ...value }
              : value;
          }
        }
        
        db.prepare(`
          INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
          VALUES (?, ?, ?, 'claude-ocr')
          ON CONFLICT(profile_id, section_key) DO UPDATE SET
            data = excluded.data, updated_at = CURRENT_TIMESTAMP, updated_by = excluded.updated_by
        `).run(profile.id, sectionKey, JSON.stringify(currentData));
        
        console.log(`  ✓ ${sectionKey}`);
      }
    }
    
    // Update display name
    if (extractedData.basic_information?.full_name) {
      const fullName = extractedData.basic_information.full_name;
      if (fullName && fullName.trim() !== 'Anastasia') {
        db.prepare('UPDATE profiles SET display_name = ? WHERE id = ?').run(fullName, profile.id);
        console.log(`  Updated name to: ${fullName}`);
      }
    }
    
    // Also save raw OCR text to document
    const doc = db.prepare("SELECT id FROM documents WHERE profile_id = ?").get(profile.id);
    if (doc) {
      db.prepare('UPDATE documents SET extracted_text = ? WHERE id = ?').run(allText, doc.id);
      console.log(`  Saved OCR text to document`);
    }
    
  } catch (error) {
    console.error('Extraction error:', error.message);
  }
  
  // Final status
  console.log('\n=== Final Profile Status ===');
  const finalProfile = db.prepare("SELECT display_name FROM profiles WHERE display_name LIKE '%Anastasia%'").get();
  const sections = db.prepare("SELECT section_key, data FROM profile_sections WHERE profile_id = (SELECT id FROM profiles WHERE display_name LIKE '%Anastasia%')").all();
  
  console.log(`Profile: ${finalProfile?.display_name}`);
  for (const s of sections) {
    const data = JSON.parse(s.data || '{}');
    const filled = Object.values(data).filter(v => v && v !== '' && (!Array.isArray(v) || v.length > 0)).length;
    console.log(`  - ${s.section_key}: ${filled} fields`);
  }
  
  db.close();
  console.log('\n✓ Done!');
}

main();
