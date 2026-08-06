import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const db = new Database('./data/grantflow.db');

// All canonical section keys
const SECTION_KEYS = [
  'basic_information',
  'demographics', 
  'education',
  'employment',
  'financial',
  'medical',
  'housing',
  'family',
  'narrative',
  'organization_details',
  'programs_services'
];

// Profiles to set up
const profiles = [
  { 
    name: 'Demo Student',
    id: '00000000-0000-4000-8000-000000000001',
    pdfPath: 'G:\\Apps\\grantflow\\GrantFlowb44\\Demo Student profile.pdf'
  },
  { name: 'Demo Workforce Training Persona', id: '7b7484c6-391c-4fb9-950f-c47759ba9440' },
  { name: 'Demo Healthcare Workforce Persona', id: '886debfb-aae3-4560-8a3e-69b098b2becc' },
  { name: 'Demo Education Support Persona', id: 'e8df3604-e54e-4359-b196-a1a39a44404e' },
  { name: 'Demo Basic Needs Persona', id: '9955410f-abb2-4772-a152-6ed2d1288879' }
];

console.log('=== Setting Up All Profiles ===\n');

for (const profile of profiles) {
  console.log(`\n--- ${profile.name} ---`);
  
  // Verify profile exists
  const existingProfile = db.prepare('SELECT id, display_name FROM profiles WHERE id = ?').get(profile.id);
  if (!existingProfile) {
    console.log(`  ERROR: Profile ${profile.id} not found!`);
    continue;
  }
  console.log(`  Profile found: ${existingProfile.display_name}`);
  
  // Get existing sections
  const existingSections = db.prepare('SELECT section_key FROM profile_sections WHERE profile_id = ?').all(profile.id);
  const existingKeys = existingSections.map(s => s.section_key);
  console.log(`  Existing sections: ${existingKeys.length}`);
  
  // Add missing sections
  const insertSection = db.prepare(`
    INSERT OR IGNORE INTO profile_sections (profile_id, section_key, data, updated_by)
    VALUES (?, ?, '{}', 'system-setup')
  `);
  
  let added = 0;
  for (const key of SECTION_KEYS) {
    if (!existingKeys.includes(key)) {
      insertSection.run(profile.id, key);
      added++;
    }
  }
  console.log(`  Added ${added} missing sections`);
  
  // Handle PDF if specified
  if (profile.pdfPath && fs.existsSync(profile.pdfPath)) {
    console.log(`  PDF found: ${profile.pdfPath}`);
    
    // Check if document already exists
    const existingDoc = db.prepare('SELECT id FROM documents WHERE profile_id = ? AND name LIKE ?').get(profile.id, '%Demo Student%');
    
    if (!existingDoc) {
      // Copy PDF to uploads
      const uploadsDir = './uploads';
      if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
      }
      
      const docId = crypto.randomUUID();
      const destFilename = `${docId}-profile.pdf`;
      const destPath = path.join(uploadsDir, destFilename);
      fs.copyFileSync(profile.pdfPath, destPath);
      
      // Store document record
      const fileSize = fs.statSync(profile.pdfPath).size;
      // Do not set documents.status on insert; rely on DB defaults.
      db.prepare(`
        INSERT INTO documents (id, profile_id, name, type, file_path, file_url, file_size, mime_type, processing_status, notes)
        VALUES (?, ?, ?, 'profile_document', ?, ?, ?, 'application/pdf', 'pending', 'Original application document - needs AI processing')
      `).run(
        docId,
        profile.id,
        path.basename(profile.pdfPath),
        destPath,
        `/uploads/${destFilename}`,
        fileSize
      );
      console.log(`  Document attached: ${docId}`);
    } else {
      console.log(`  Document already attached: ${existingDoc.id}`);
    }
  }
  
  // Final count
  const finalSections = db.prepare('SELECT COUNT(*) as count FROM profile_sections WHERE profile_id = ?').get(profile.id);
  const finalDocs = db.prepare('SELECT COUNT(*) as count FROM documents WHERE profile_id = ?').get(profile.id);
  console.log(`  Final: ${finalSections.count} sections, ${finalDocs.count} documents`);
}

console.log('\n=== Summary ===');
for (const profile of profiles) {
  const sections = db.prepare('SELECT section_key FROM profile_sections WHERE profile_id = ?').all(profile.id);
  const docs = db.prepare('SELECT name FROM documents WHERE profile_id = ?').all(profile.id);
  console.log(`${profile.name}: ${sections.length} sections, ${docs.length} docs`);
}

db.close();
console.log('\nDone!');
