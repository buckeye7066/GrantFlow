import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import pdfParse from 'pdf-parse';

const db = new Database('./data/grantflow.db');
const docsFolder = 'G:\\Apps\\grantflow\\GrantFlowb44';

// Map documents to existing profile IDs (no duplicates!)
const profileMappings = [
  { file: 'Anastasia profile.pdf', profileId: 'c4a92724-9cee-416f-ba30-e91b9b5cd885' },
  { file: 'Avanell profile.pdf', profileId: 'profile-avanell-leamon' },
  { file: 'Allen profile.pdf', profileId: 'profile-gilbert-mccosh' },
  { file: 'John Profile.pdf', profileId: 'profile-john-white' },
  { file: 'Kim profile.pdf', profileId: null }, // Need to find/create
  { file: 'Luba profile.pdf', profileId: null }, // Need to find/create
  { file: 'Brian.pdf', profileId: 'profile-brian-client' },
  { file: 'Hollie.pdf', profileId: 'profile-hollie-knox' },
  { file: 'Oliva.pdf', profileId: 'profile-olivia-beltran' },
  { file: 'Focus Forward Ministries Profile.pdf', profileId: 'profile-focus-forward-ministries' },
];

// Ensure uploads directory exists
const uploadsDir = './uploads';
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Parse extracted text to find profile data
function parseProfileData(text) {
  const data = {
    basic_information: {},
    demographics: {},
    narrative: {},
    financial: {},
    medical: {},
    education: {},
    employment: {}
  };
  
  // Extract name
  const nameMatch = text.match(/Name\s*\n?\s*([A-Za-z\s]+?)(?:\n|Email)/i);
  if (nameMatch) data.basic_information.full_name = nameMatch[1].trim();
  
  // Extract email
  const emailMatch = text.match(/Email\s*\n?\s*([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i);
  if (emailMatch) data.basic_information.email = emailMatch[1].trim();
  
  // Extract phone
  const phoneMatch = text.match(/Phone\s*\n?\s*(\d{10}|\d{3}[-.\s]?\d{3}[-.\s]?\d{4})/i);
  if (phoneMatch) data.basic_information.phone = phoneMatch[1].trim();
  
  // Extract address
  const addressMatch = text.match(/Address\s*\n?\s*(.+?)\n(.+?,\s*[A-Z]{2}\s*\d{5})/is);
  if (addressMatch) {
    data.basic_information.address = {
      street: addressMatch[1].trim(),
      full: addressMatch[2].trim()
    };
  }
  
  // Extract DOB
  const dobMatch = text.match(/Date of Birth.*?(\d{2}\/\d{2}\/\d{4})/i);
  if (dobMatch) data.basic_information.date_of_birth = dobMatch[1];
  
  // Extract SSN last 4
  const ssnMatch = text.match(/SSN\s*\n?\s*\*+-(\d{3,4})/i);
  if (ssnMatch) data.basic_information.ssn_last4 = ssnMatch[1];
  
  // Extract narrative/mission
  const missionMatch = text.match(/Mission \/ Bio\s*\n?([\s\S]+?)(?=Keywords|Focus Areas|$)/i);
  if (missionMatch) {
    data.narrative.personal_statement = missionMatch[1].trim().substring(0, 2000);
  }
  
  // Extract demographics
  if (text.includes('White / Caucasian')) data.demographics.ethnicity = 'White/Caucasian';
  if (text.includes('African American')) data.demographics.ethnicity = 'African American';
  if (text.includes('Hispanic')) data.demographics.ethnicity = 'Hispanic/Latino';
  if (text.includes('Senior 55+')) data.demographics.age_group = 'Senior 55+';
  if (text.includes('Senior 62+')) data.demographics.age_group = 'Senior 62+';
  if (text.match(/veteran/i)) data.demographics.veteran_status = 'Veteran';
  if (text.match(/disability|disabled/i)) data.demographics.disability_status = 'Has disability';
  if (text.match(/us citizen/i)) data.demographics.citizenship = 'US Citizen';
  
  // Extract keywords
  const keywordsSection = text.match(/Keywords[\s\S]*?(?=Focus Areas|Program Areas|$)/i);
  if (keywordsSection) {
    const keywords = keywordsSection[0].match(/([a-z\s-]+(?:grants?|funding|support|assistance|programs?|services?))/gi);
    if (keywords) data.basic_information.keywords = [...new Set(keywords.map(k => k.trim()))].slice(0, 10);
  }
  
  return data;
}

async function processDocument(mapping) {
  const pdfPath = path.join(docsFolder, mapping.file);
  
  console.log(`\n--- ${mapping.file} ---`);
  
  if (!fs.existsSync(pdfPath)) {
    console.log('  SKIP: File not found');
    return;
  }
  
  // Find or verify profile
  let profileId = mapping.profileId;
  if (!profileId) {
    // Try to find by name in file
    const baseName = mapping.file.replace(/\s*profile\.pdf$/i, '').replace('.pdf', '');
    const existing = db.prepare(`SELECT id FROM profiles WHERE display_name LIKE ?`).get(`%${baseName}%`);
    if (existing) {
      profileId = existing.id;
    } else {
      console.log(`  SKIP: No matching profile for ${baseName}`);
      return;
    }
  }
  
  // Verify profile exists
  const profile = db.prepare('SELECT id, display_name FROM profiles WHERE id = ?').get(profileId);
  if (!profile) {
    console.log(`  ERROR: Profile ${profileId} not found`);
    return;
  }
  console.log(`  Profile: ${profile.display_name} (${profileId})`);
  
  // Read PDF
  const fileSize = fs.statSync(pdfPath).size;
  let extractedText = '';
  try {
    const buffer = fs.readFileSync(pdfPath);
    const pdfData = await pdfParse(buffer);
    extractedText = pdfData.text || '';
    console.log(`  Extracted ${extractedText.length} chars`);
  } catch (err) {
    console.log(`  PDF parse error: ${err.message}`);
  }
  
  // Check if document already attached
  let existingDoc = db.prepare('SELECT id FROM documents WHERE profile_id = ? AND name = ?').get(profileId, mapping.file);
  
  if (!existingDoc) {
    // Copy PDF to uploads and attach
    const docId = crypto.randomUUID();
    const destFilename = `${docId}-${mapping.file.replace(/\s+/g, '-')}`;
    const destPath = path.join(uploadsDir, destFilename);
    fs.copyFileSync(pdfPath, destPath);
    
    db.prepare(`
      INSERT INTO documents (id, profile_id, name, type, file_path, file_url, file_size, mime_type, extracted_text, processing_status, status, notes)
      VALUES (?, ?, ?, 'profile_document', ?, ?, ?, 'application/pdf', ?, 'completed', 'final', 'Original application document')
    `).run(docId, profileId, mapping.file, destPath, `/uploads/${destFilename}`, fileSize, extractedText);
    
    console.log(`  Document attached: ${docId}`);
  } else {
    // Update existing document with extracted text
    db.prepare('UPDATE documents SET extracted_text = ?, processing_status = ? WHERE id = ?')
      .run(extractedText, 'completed', existingDoc.id);
    console.log(`  Document updated: ${existingDoc.id}`);
  }
  
  // Parse and update profile sections
  if (extractedText.length > 100) {
    const parsedData = parseProfileData(extractedText);
    
    // Update sections
    const updateSection = db.prepare(`
      INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
      VALUES (?, ?, ?, 'document-parse')
      ON CONFLICT(profile_id, section_key) DO UPDATE SET
        data = json_patch(data, excluded.data),
        updated_at = CURRENT_TIMESTAMP,
        updated_by = 'document-parse'
    `);
    
    let sectionsUpdated = 0;
    for (const [sectionKey, sectionData] of Object.entries(parsedData)) {
      if (Object.keys(sectionData).length > 0) {
        // Get existing data
        const existing = db.prepare('SELECT data FROM profile_sections WHERE profile_id = ? AND section_key = ?').get(profileId, sectionKey);
        const existingData = existing ? JSON.parse(existing.data || '{}') : {};
        
        // Merge new data (don't overwrite existing non-empty values)
        const mergedData = { ...existingData };
        for (const [key, value] of Object.entries(sectionData)) {
          if (value && (!existingData[key] || existingData[key] === '')) {
            mergedData[key] = value;
          }
        }
        
        db.prepare(`
          INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
          VALUES (?, ?, ?, 'document-parse')
          ON CONFLICT(profile_id, section_key) DO UPDATE SET
            data = excluded.data,
            updated_at = CURRENT_TIMESTAMP,
            updated_by = 'document-parse'
        `).run(profileId, sectionKey, JSON.stringify(mergedData));
        
        sectionsUpdated++;
      }
    }
    console.log(`  Updated ${sectionsUpdated} sections with parsed data`);
  }
}

async function main() {
  console.log('=== Updating Existing Profiles from Documents ===');
  
  for (const mapping of profileMappings) {
    await processDocument(mapping);
  }
  
  // Final summary
  console.log('\n\n=== FINAL SUMMARY ===\n');
  
  const allProfiles = db.prepare(`
    SELECT p.id, p.display_name,
      (SELECT COUNT(*) FROM documents WHERE profile_id = p.id) as docs,
      (SELECT COUNT(*) FROM profile_sections WHERE profile_id = p.id AND data != '{}') as filled_sections
    FROM profiles p
    ORDER BY p.display_name
  `).all();
  
  console.log('Profile                  | Docs | Filled Sections');
  console.log('-------------------------|------|----------------');
  for (const p of allProfiles) {
    console.log(`${p.display_name.padEnd(24)} | ${String(p.docs).padStart(4)} | ${String(p.filled_sections).padStart(15)}`);
  }
  
  db.close();
  console.log('\nDone!');
}

main().catch(console.error);
