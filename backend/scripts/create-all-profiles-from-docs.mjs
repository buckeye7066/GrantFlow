/**
 * Import profile documents into an explicitly confirmed SQLite database.
 *
 * Required env: PROFILE_DOCS_DB_PATH, PROFILE_DOCS_CONFIRM_DB_PATH,
 * PROFILE_DOCS_SOURCE_DIR, PROFILE_DOCS_UPLOADS_DIR,
 * PROFILE_DOCS_ADMIN_USER_ID, and PROFILE_DOCS_CONFIRM=CREATE_PROFILES.
 * PROFILE_DOCS_SOURCE_DIR must contain a private `profiles.json` manifest:
 * [{ "file": "applicant.pdf", "name": "Applicant", "type": "individual" }].
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import pdfParse from 'pdf-parse';
import process from 'node:process';
import { guardProfileSectionForWrite } from '../utils/guardedProfileSectionWrite.js';

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required; this mutating script has no path or identity defaults`);
  return value;
}

const dbPath = path.resolve(process.cwd(), requiredEnv('PROFILE_DOCS_DB_PATH'));
const confirmedDbPath = path.resolve(process.cwd(), requiredEnv('PROFILE_DOCS_CONFIRM_DB_PATH'));
const docsFolder = path.resolve(process.cwd(), requiredEnv('PROFILE_DOCS_SOURCE_DIR'));
const uploadsDir = path.resolve(process.cwd(), requiredEnv('PROFILE_DOCS_UPLOADS_DIR'));
const adminUserId = requiredEnv('PROFILE_DOCS_ADMIN_USER_ID');
if (confirmedDbPath !== dbPath) {
  throw new Error('PROFILE_DOCS_CONFIRM_DB_PATH must resolve to exactly PROFILE_DOCS_DB_PATH');
}
if (requiredEnv('PROFILE_DOCS_CONFIRM') !== 'CREATE_PROFILES') {
  throw new Error('PROFILE_DOCS_CONFIRM must equal CREATE_PROFILES');
}
if (!fs.existsSync(dbPath)) throw new Error(`PROFILE_DOCS_DB_PATH does not exist: ${dbPath}`);
if (!fs.existsSync(docsFolder) || !fs.statSync(docsFolder).isDirectory()) {
  throw new Error(`PROFILE_DOCS_SOURCE_DIR is not a directory: ${docsFolder}`);
}

const db = new Database(dbPath, { fileMustExist: true });

// All canonical section keys
const SECTION_KEYS = [
  'basic_information', 'demographics', 'education', 'employment',
  'financial', 'medical', 'housing', 'family', 'narrative',
  'organization_details', 'programs_services'
];

// Resolve only the explicitly selected, DB-authorized admin.
const adminUser = db.prepare(`
  SELECT id
  FROM users
  WHERE id = ? AND COALESCE(is_admin, 0) = 1
  LIMIT 1
`).get(adminUserId);
const adminId = adminUser?.id;
if (!adminId) {
  db.close();
  throw new Error('PROFILE_DOCS_ADMIN_USER_ID is not a DB-authorized admin');
}
console.log('Admin ID:', adminId);

// Profile identities and source filenames are private operator data, never
// public-repository defaults. Load and validate the explicit private manifest.
const manifestPath = path.join(docsFolder, 'profiles.json');
if (!fs.existsSync(manifestPath) || !fs.statSync(manifestPath).isFile()) {
  db.close();
  throw new Error('PROFILE_DOCS_SOURCE_DIR must contain a private profiles.json manifest');
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const profileDocs = Array.isArray(manifest) ? manifest : manifest?.profiles;
if (!Array.isArray(profileDocs) || profileDocs.length === 0 || profileDocs.length > 500) {
  db.close();
  throw new Error('profiles.json must contain 1-500 profile document entries');
}
const allowedProfileTypes = new Set(['individual', 'family', 'student', 'nonprofit', 'business', 'school', 'government']);
for (const [index, doc] of profileDocs.entries()) {
  const file = String(doc?.file || '').trim();
  const name = String(doc?.name || '').trim();
  const type = String(doc?.type || '').trim().toLowerCase();
  if (!file || path.basename(file) !== file || !/\.pdf$/i.test(file)) {
    db.close();
    throw new Error(`profiles.json entry ${index} must name one PDF filename without a path`);
  }
  if (!name || name.length > 200 || !allowedProfileTypes.has(type)) {
    db.close();
    throw new Error(`profiles.json entry ${index} has an invalid name or profile type`);
  }
  doc.file = file;
  doc.name = name;
  doc.type = type;
}

// Ensure the explicitly selected uploads directory exists.
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
      VALUES (?, ?, ?, 'draft', '[]', ?)
    `).run(profileId, doc.name, doc.type, adminId);
    
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
    VALUES (?, ?, ?, 'system-setup')
  `);
  
  let sectionsAdded = 0;
  for (const key of SECTION_KEYS) {
    if (!existingKeys.includes(key)) {
      const guarded = await guardProfileSectionForWrite(db, profile.id, key, {});
      insertSection.run(profile.id, key, JSON.stringify(guarded.data));
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
    INSERT INTO documents (id, profile_id, name, type, file_path, file_url, file_size, mime_type, extracted_text, processing_status, notes)
    VALUES (?, ?, ?, 'profile_document', ?, ?, ?, 'application/pdf', ?, ?, 'Original application document')
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
  WHERE p.display_name IN ('Demo Workforce Training Persona', 'Demo Healthcare Workforce Persona', 'Demo Education Support Persona', 'Demo Basic Needs Persona')
  ORDER BY p.display_name
`).all();

for (const p of otherProfiles) {
  const name = p.display_name.padEnd(24);
  const type = p.primary_type.padEnd(10);
  console.log(`${name} | ${type} | ${String(p.sections).padStart(8)} | ${String(p.docs).padStart(9)}`);
}

db.close();
console.log('\nDone!');
