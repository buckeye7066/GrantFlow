import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { guardProfileSectionForWrite } from '../utils/guardedProfileSectionWrite.js';

const db = new Database('./data/grantflow.db');

console.log('=== Updating Anastasia Nicole White Profile ===\n');

// Find Anastasia profile
const profile = db.prepare("SELECT id, display_name FROM profiles WHERE display_name LIKE '%Anastasia%'").get();
if (!profile) {
  console.error('Anastasia profile not found!');
  process.exit(1);
}

console.log(`Found profile: ${profile.display_name} (${profile.id})`);

const dataPath = path.resolve(process.cwd(), 'backend/config/profile-anastasia.json');
if (!fs.existsSync(dataPath)) {
  console.error('Profile data file not found:', dataPath);
  process.exit(1);
}

const raw = fs.readFileSync(dataPath, 'utf8');
const parsed = JSON.parse(raw);
const profileData = parsed?.sections ?? null;
if (!profileData || typeof profileData !== 'object') {
  console.error('Invalid profile data file shape (expected {"sections": {...}}).');
  process.exit(1);
}

const displayName = parsed?.profile?.display_name || 'Anastasia Nicole White';
db.prepare('UPDATE profiles SET display_name = ? WHERE id = ?').run(displayName, profile.id);
console.log(`✓ Updated display name to: ${displayName}`);

// Update each section
for (const [sectionKey, sectionData] of Object.entries(profileData)) {
  const guarded = await guardProfileSectionForWrite(db, profile.id, sectionKey, sectionData);
  db.prepare(`
    INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
    VALUES (?, ?, ?, 'ocr-extraction')
    ON CONFLICT(profile_id, section_key) DO UPDATE SET
      data = excluded.data,
      updated_at = CURRENT_TIMESTAMP,
      updated_by = excluded.updated_by
  `).run(profile.id, sectionKey, JSON.stringify(guarded.data));
  
  const fieldCount = Object.keys(sectionData).length;
  console.log(`✓ ${sectionKey}: ${fieldCount} fields`);
}

// Final summary
console.log('\n=== FINAL PROFILE STATUS ===');
const finalProfile = db.prepare('SELECT display_name FROM profiles WHERE id = ?').get(profile.id);
console.log(`Profile: ${finalProfile.display_name}`);

const sections = db.prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?').all(profile.id);
console.log(`Total sections: ${sections.length}`);

for (const s of sections) {
  const data = JSON.parse(s.data || '{}');
  const filled = Object.keys(data).length;
  console.log(`  - ${s.section_key}: ${filled} fields`);
}

const docCount = db.prepare('SELECT COUNT(*) as count FROM profile_documents WHERE profile_id = ?').get(profile.id);
console.log(`Documents attached: ${docCount.count}`);

db.close();
console.log('\n✓ DONE!');
