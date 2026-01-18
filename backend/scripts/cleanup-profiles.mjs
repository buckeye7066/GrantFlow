import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import pdfParse from 'pdf-parse';

const db = new Database('./data/grantflow.db');
const docsFolder = 'G:\\Apps\\grantflow\\GrantFlowb44';
const uploadsDir = './uploads';

console.log('=== Cleanup and Fix Profiles ===\n');

// 1. Delete duplicate Avanell (keep the seeded one with more data)
const dupAvanell = db.prepare(`SELECT id FROM profiles WHERE id = '3ef853ef-880c-48c6-a112-29f1472844eb'`).get();
if (dupAvanell) {
  db.prepare('DELETE FROM profile_sections WHERE profile_id = ?').run(dupAvanell.id);
  db.prepare('DELETE FROM documents WHERE profile_id = ?').run(dupAvanell.id);
  db.prepare('DELETE FROM profiles WHERE id = ?').run(dupAvanell.id);
  console.log('✓ Deleted duplicate Avanell profile');
}

// 2. Check for Kim profile - create if missing
let kimProfile = db.prepare(`SELECT id, display_name FROM profiles WHERE display_name LIKE '%Kim%'`).get();
if (!kimProfile) {
  const kimId = crypto.randomUUID();
  db.prepare(`INSERT INTO profiles (id, display_name, primary_type, status, tags, created_by) VALUES (?, 'Kim', 'individual', 'draft', '[]', 'admin')`).run(kimId);
  kimProfile = { id: kimId, display_name: 'Kim' };
  console.log('✓ Created Kim profile:', kimId);
} else {
  console.log('✓ Kim profile exists:', kimProfile.display_name);
}

// 3. Check for Luba profile - create if missing  
let lubaProfile = db.prepare(`SELECT id, display_name FROM profiles WHERE display_name LIKE '%Luba%'`).get();
if (!lubaProfile) {
  const lubaId = crypto.randomUUID();
  db.prepare(`INSERT INTO profiles (id, display_name, primary_type, status, tags, created_by) VALUES (?, 'Luba', 'individual', 'draft', '[]', 'admin')`).run(lubaId);
  lubaProfile = { id: lubaId, display_name: 'Luba' };
  console.log('✓ Created Luba profile:', lubaId);
} else {
  console.log('✓ Luba profile exists:', lubaProfile.display_name);
}

// 4. Attach Kim and Luba documents
async function attachDocument(profileId, fileName) {
  const pdfPath = path.join(docsFolder, fileName);
  if (!fs.existsSync(pdfPath)) {
    console.log(`  Skip: ${fileName} not found`);
    return;
  }
  
  // Check if already attached
  const existing = db.prepare('SELECT id FROM documents WHERE profile_id = ? AND name = ?').get(profileId, fileName);
  if (existing) {
    console.log(`  Document already attached: ${fileName}`);
    return;
  }
  
  // Read and parse PDF
  const fileSize = fs.statSync(pdfPath).size;
  let extractedText = '';
  try {
    const buffer = fs.readFileSync(pdfPath);
    const pdfData = await pdfParse(buffer);
    extractedText = pdfData.text || '';
  } catch (e) {
    console.log(`  PDF parse error: ${e.message}`);
  }
  
  // Copy to uploads
  const docId = crypto.randomUUID();
  const destFilename = `${docId}-${fileName.replace(/\s+/g, '-')}`;
  const destPath = path.join(uploadsDir, destFilename);
  fs.copyFileSync(pdfPath, destPath);
  
  // Insert document record
  db.prepare(`
    INSERT INTO documents (id, profile_id, name, type, file_path, file_url, file_size, mime_type, extracted_text, processing_status, notes)
    VALUES (?, ?, ?, 'profile_document', ?, ?, ?, 'application/pdf', ?, 'completed', 'Original application document')
  `).run(docId, profileId, fileName, destPath, `/uploads/${destFilename}`, fileSize, extractedText);
  
  console.log(`  ✓ Attached ${fileName} (${extractedText.length} chars extracted)`);
  
  // Parse and store basic info
  if (extractedText.length > 100) {
    const nameMatch = extractedText.match(/Name\s*\n?\s*([A-Za-z\s]+?)(?:\n|Email)/i);
    const emailMatch = extractedText.match(/Email\s*\n?\s*([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i);
    const phoneMatch = extractedText.match(/Phone\s*\n?\s*(\d{10}|\d{3}[-.\s]?\d{3}[-.\s]?\d{4})/i);
    const addressMatch = extractedText.match(/Address\s*\n?\s*(.+?)\n(.+?,\s*[A-Z]{2}\s*\d{5})/is);
    const missionMatch = extractedText.match(/Mission \/ Bio\s*\n?([\s\S]+?)(?=Keywords|Focus Areas|$)/i);
    
    const basicInfo = {};
    if (nameMatch) basicInfo.full_name = nameMatch[1].trim();
    if (emailMatch) basicInfo.email = emailMatch[1].trim();
    if (phoneMatch) basicInfo.phone = phoneMatch[1].trim();
    if (addressMatch) basicInfo.address = { street: addressMatch[1].trim(), full: addressMatch[2].trim() };
    
    if (Object.keys(basicInfo).length > 0) {
      db.prepare(`
        INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
        VALUES (?, 'basic_information', ?, 'document-parse')
        ON CONFLICT(profile_id, section_key) DO UPDATE SET data = excluded.data, updated_at = CURRENT_TIMESTAMP
      `).run(profileId, JSON.stringify(basicInfo));
      
      // Update profile display name if we got a full name
      if (basicInfo.full_name) {
        db.prepare('UPDATE profiles SET display_name = ? WHERE id = ?').run(basicInfo.full_name, profileId);
        console.log(`  Updated name to: ${basicInfo.full_name}`);
      }
    }
    
    if (missionMatch) {
      db.prepare(`
        INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
        VALUES (?, 'narrative', ?, 'document-parse')
        ON CONFLICT(profile_id, section_key) DO UPDATE SET data = excluded.data, updated_at = CURRENT_TIMESTAMP
      `).run(profileId, JSON.stringify({ personal_statement: missionMatch[1].trim().substring(0, 2000) }));
    }
  }
}

// Process Kim and Luba
console.log('\nProcessing Kim profile...');
await attachDocument(kimProfile.id, 'Kim profile.pdf');

console.log('\nProcessing Luba profile...');
await attachDocument(lubaProfile.id, 'Luba profile.pdf');

// 5. Final summary
console.log('\n\n=== FINAL PROFILE STATUS ===\n');

const allProfiles = db.prepare(`
  SELECT p.id, p.display_name, p.primary_type,
    (SELECT COUNT(*) FROM documents WHERE profile_id = p.id) as docs,
    (SELECT COUNT(*) FROM profile_sections WHERE profile_id = p.id AND data != '{}') as sections
  FROM profiles p
  ORDER BY p.display_name
`).all();

console.log('Profile                         | Type         | Docs | Sections');
console.log('--------------------------------|--------------|------|----------');
for (const p of allProfiles) {
  console.log(`${p.display_name.padEnd(31)} | ${(p.primary_type || 'unknown').padEnd(12)} | ${String(p.docs).padStart(4)} | ${String(p.sections).padStart(8)}`);
}

db.close();
console.log('\n✓ Done!');
