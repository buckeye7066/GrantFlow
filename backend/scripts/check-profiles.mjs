import Database from 'better-sqlite3';

const db = new Database('./data/grantflow.db');

// Get all profiles I created
const profiles = db.prepare(`
  SELECT id, display_name, primary_type, status, created_at 
  FROM profiles 
  WHERE display_name IN ('Demo Student', 'Demo Student Profile', 'Demo Workforce Training Persona', 'Demo Healthcare Workforce Persona', 'Demo Education Support Persona', 'Demo Basic Needs Persona')
  ORDER BY created_at DESC
`).all();

console.log('=== PROFILES ===');
profiles.forEach(p => console.log(JSON.stringify(p)));

// Get documents for these profiles
const profileIds = profiles.map(p => p.id);
if (profileIds.length > 0) {
  const placeholders = profileIds.map(() => '?').join(',');
  const docs = db.prepare(`
    SELECT d.id, d.profile_id, d.name, d.extracted_text, d.processing_status
    FROM documents d
    WHERE d.profile_id IN (${placeholders})
  `).all(...profileIds);
  
  console.log('\n=== DOCUMENTS ===');
  docs.forEach(d => console.log(JSON.stringify({
    id: d.id,
    profile_id: d.profile_id,
    name: d.name,
    has_text: d.extracted_text ? d.extracted_text.length : 0,
    status: d.processing_status
  })));
}

// Get sections for these profiles
console.log('\n=== PROFILE SECTIONS ===');
profileIds.forEach(pid => {
  const sections = db.prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?').all(pid);
  const profile = profiles.find(p => p.id === pid);
  console.log(profile?.display_name + ': ' + sections.length + ' sections');
  sections.forEach(s => {
    const data = JSON.parse(s.data || '{}');
    const hasData = Object.keys(data).some(k => data[k] && data[k] !== '');
    console.log('  - ' + s.section_key + ': ' + (hasData ? 'HAS DATA' : 'empty'));
  });
});

db.close();
