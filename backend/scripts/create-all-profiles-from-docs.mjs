import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import pdfParse from 'pdf-parse';

const db = new Database('./data/grantflow.db');
const docsFolder = 'G:\\Apps\\grantflow\\GrantFlowb44';

// All canonical section keys
const SECTION_KEYS = [
  'basic_information', 'demographics', 'education', 'employment',
  'financial', 'medical', 'housing', 'family', 'narrative',
  'organization_details', 'programs_services'
];

// Get admin user ID
const adminUser = db.prepare(`SELECT id FROM users WHERE primary_email LIKE '%buckeye7066%' OR is_admin = 1`).get();
const adminId = adminUser?.id;
console.log('Admin ID:', adminId);

// Profile documents to process
const profileDocs = [
  { file: 'Anastasia profile.pdf', name: 'Anastasia', type: 'individual' },
  { file: 'Avanell profile.pdf', name: 'Avanell', type: 'individual' },
  { file: 'Allen profile.pdf', name: 'Allen', type: 'individual' },
  { file: 'John Profile.pdf', name: 'John', type: 'individual' },
  { file: 'Kim profile.pdf', name: 'Kim', type: 'individual' },
  { file: 'Luba profile.pdf', name: 'Luba', type: 'individual' },
  { file: 'Brian.pdf', name: 'Brian', type: 'individual' },
  { file: 'Hollie.pdf', name: 'Hollie', type: 'individual' },
  { file: 'Oliva.pdf', name: 'Oliva', type: 'individual' },
  { file: 'Focus Forward Ministries Profile.pdf', name: 'Focus Forward Ministries', type: 'nonprofit' },
];

// Ensure uploads directory exists
const uploadsDir = './uploads';
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

console.log('\n=== Creating Profiles from Documents ===\n');

for (const doc of profileDocs) {
  const pdfPath = path.join(docsFolder, doc.file);
  
  console.log(`\n--- ${doc.name} ---`);
  
  if (!fs.existsSync(pdfPath)) {
    console.log(`  SKIP: File not found: ${doc.file}`);
    continue;
  }
  
  const fileSize = fs.statSync(pdfPath).size;
  console.log(`  File: ${doc.file} (${(fileSize / 1024).toFixed(0)} KB)`);
  
  // Check if profile already exists
  let profile = db.prepare(`SELECT id, display_name FROM profiles WHERE display_name = ?`).get(doc.name);
  
  if (!profile) {
    // Create new profile
    const profileId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO profiles (id, display_name, primary_type, status, tags, created_by)
      VALUES (?, ?, ?, 'draft', '[]', 'admin')
    `).run(profileId, doc.name, doc.type);
    
    profile = { id: profileId, display_name: doc.name };
    console.log(`  Created profile: ${profileId}`);
    
    // Link to admin
    if (adminId) {
      db.prepare(`
        INSERT OR IGNORE INTO user_profiles (user_id, profile_id, role)
        VALUES (?, ?, 'admin')
      `).run(adminId, profileId);
    }
  } else {
    console.log(`  Existing profile: ${profile.id}`);
  }
  
  // Add all sections
  const existingSections = db.prepare('SELECT section_key FROM profile_sections WHERE profile_id = ?').all(profile.id);
  const existingKeys = existingSections.map(s => s.section_key);
  
  const insertSection = db.prepare(`
    INSERT OR IGNORE INTO profile_sections (profile_id, section_key, data, updated_by)
    VALUES (?, ?, '{}', 'system-setup')
  `);
  
  let sectionsAdded = 0;
  for (const key of SECTION_KEYS) {
    if (!existingKeys.includes(key)) {
      insertSection.run(profile.id, key);
      sectionsAdded++;
    }
  }
  if (sectionsAdded > 0) {
    console.log(`  Added ${sectionsAdded} sections`);
  }
  
  // Check if document already attached
  const existingDoc = db.prepare(`SELECT id FROM documents WHERE profile_id = ? AND name = ?`).get(profile.id, doc.file);
  
  if (existingDoc) {
    console.log(`  Document already attached: ${existingDoc.id}`);
    continue;
  }
  
  // Copy PDF to uploads
  const docId = crypto.randomUUID();
  const destFilename = `${docId}-${doc.file.replace(/\s+/g, '-')}`;
  const destPath = path.join(uploadsDir, destFilename);
  fs.copyFileSync(pdfPath, destPath);
  
  // Try to extract text
  let extractedText = '';
  try {
    const pdfBuffer = fs.readFileSync(pdfPath);
    const pdfData = await pdfParse(pdfBuffer);
    extractedText = pdfData.text || '';
    console.log(`  Extracted ${extractedText.length} chars`);
  } catch (err) {
    console.log(`  PDF parse error: ${err.message}`);
  }
  
  // Store document record
  db.prepare(`
    INSERT INTO documents (id, profile_id, name, type, file_path, file_url, file_size, mime_type, extracted_text, processing_status, status, notes)
    VALUES (?, ?, ?, 'profile_document', ?, ?, ?, 'application/pdf', ?, ?, 'final', 'Original application document')
  `).run(
    docId,
    profile.id,
    doc.file,
    destPath,
    `/uploads/${destFilename}`,
    fileSize,
    extractedText,
    extractedText.length > 100 ? 'completed' : 'pending_ocr'
  );
  
  console.log(`  Document attached: ${docId}`);
}

// Final summary
console.log('\n\n=== FINAL SUMMARY ===\n');

const allProfiles = db.prepare(`
  SELECT p.id, p.display_name, p.primary_type,
    (SELECT COUNT(*) FROM profile_sections WHERE profile_id = p.id) as sections,
    (SELECT COUNT(*) FROM documents WHERE profile_id = p.id) as docs
  FROM profiles p
  WHERE p.display_name IN (${profileDocs.map(() => '?').join(',')})
  ORDER BY p.display_name
`).all(...profileDocs.map(d => d.name));

console.log('Profile Name             | Type       | Sections | Documents');
console.log('-------------------------|------------|----------|----------');
for (const p of allProfiles) {
  const name = p.display_name.padEnd(24);
  const type = p.primary_type.padEnd(10);
  console.log(`${name} | ${type} | ${String(p.sections).padStart(8)} | ${String(p.docs).padStart(9)}`);
}

// Also show the manually created profiles
console.log('\n--- Previously Created Profiles ---');
const otherProfiles = db.prepare(`
  SELECT p.id, p.display_name, p.primary_type,
    (SELECT COUNT(*) FROM profile_sections WHERE profile_id = p.id) as sections,
    (SELECT COUNT(*) FROM documents WHERE profile_id = p.id) as docs
  FROM profiles p
  WHERE p.display_name IN ('Paul Jason Dasher', 'Angelika Ptak', 'Rachel Miller', 'Kathy Marie Daniel')
  ORDER BY p.display_name
`).all();

for (const p of otherProfiles) {
  const name = p.display_name.padEnd(24);
  const type = p.primary_type.padEnd(10);
  console.log(`${name} | ${type} | ${String(p.sections).padStart(8)} | ${String(p.docs).padStart(9)}`);
}

db.close();
console.log('\nDone!');
