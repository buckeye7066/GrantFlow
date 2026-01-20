import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const db = new Database('./data/grantflow.db');

console.log('=== EXPORTING PROFILES FOR PRODUCTION SEED ===\n');

// Export profiles
const profiles = db.prepare(`
  SELECT id, display_name, primary_type, status, tags, organization_id, avatar_url, created_at
  FROM profiles
`).all();

console.log(`Found ${profiles.length} profiles`);

// Export profile sections
const sections = db.prepare(`
  SELECT profile_id, section_key, data
  FROM profile_sections
`).all();

console.log(`Found ${sections.length} sections`);

// Export user_profiles links
const userProfiles = db.prepare(`
  SELECT user_id, profile_id
  FROM user_profiles
`).all();

console.log(`Found ${userProfiles.length} user-profile links`);

// Export organizations
const organizations = db.prepare(`
  SELECT * FROM organizations
`).all();

console.log(`Found ${organizations.length} organizations`);

// Export profile_organizations links
const profileOrgs = db.prepare(`
  SELECT profile_id, organization_id FROM profile_organizations
`).all();

console.log(`Found ${profileOrgs.length} profile-org links`);

// Export funding_opportunities
const opportunities = db.prepare(`
  SELECT * FROM funding_opportunities WHERE is_active = 1 LIMIT 100
`).all();

console.log(`Found ${opportunities.length} opportunities`);

// Export grants
const grants = db.prepare(`
  SELECT * FROM grants
`).all();

console.log(`Found ${grants.length} grants`);

// Export documents
const documents = db.prepare(`
  SELECT id, profile_id, name, type, file_url, mime_type, extracted_text, processing_status, status, notes
  FROM documents
`).all();

console.log(`Found ${documents.length} documents`);

// Export profile_documents links
const profileDocs = db.prepare(`
  SELECT profile_id, document_id FROM profile_documents
`).all();

console.log(`Found ${profileDocs.length} profile-document links`);

// Create seed payload
const payload = {
  exported_at: new Date().toISOString(),
  profiles: profiles.map(p => ({
    id: p.id,
    display_name: p.display_name,
    primary_type: p.primary_type || 'individual',
    status: p.status || 'active',
    tags: p.tags || '[]',
    organization_id: p.organization_id,
    avatar_url: p.avatar_url
  })),
  sections: sections.map(s => ({
    profile_id: s.profile_id,
    section_key: s.section_key,
    data: s.data
  })),
  user_profiles: userProfiles,
  organizations: organizations,
  profile_organizations: profileOrgs,
  funding_opportunities: opportunities,
  grants: grants,
  documents: documents.map(d => ({
    id: d.id,
    profile_id: d.profile_id,
    name: d.name,
    type: d.type || 'profile_document',
    file_url: d.file_url,
    mime_type: d.mime_type,
    extracted_text: d.extracted_text,
    processing_status: d.processing_status || 'completed',
    status: d.status || 'active',
    notes: d.notes
  })),
  profile_documents: profileDocs
};

// Write to seed file (in root seed/ directory)
const seedDir = path.join(process.cwd(), '..', 'seed');
if (!fs.existsSync(seedDir)) {
  fs.mkdirSync(seedDir, { recursive: true });
}
const seedPath = path.join(seedDir, 'baseline-profiles.json');
fs.writeFileSync(seedPath, JSON.stringify(payload, null, 2));

console.log(`\n✓ Exported to ${seedPath}`);
console.log(`  - ${payload.profiles.length} profiles`);
console.log(`  - ${payload.sections.length} sections`);
console.log(`  - ${payload.organizations.length} organizations`);
console.log(`  - ${payload.grants.length} grants`);
console.log(`  - ${payload.documents.length} documents`);
console.log(`  - ${payload.profile_documents.length} profile-document links`);

db.close();
