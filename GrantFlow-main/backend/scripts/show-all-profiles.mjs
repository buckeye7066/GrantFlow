import Database from 'better-sqlite3';

const db = new Database('./data/grantflow.db');

console.log('=== ALL PROFILES STATUS ===\n');
console.log('Profile                          | Type         | Sections | Docs | Data Fields');
console.log('---------------------------------|--------------|----------|------|------------');

const profiles = db.prepare('SELECT id, display_name, primary_type FROM profiles ORDER BY display_name').all();

profiles.forEach(p => {
  const sections = db.prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?').all(p.id);
  const docCount = db.prepare('SELECT COUNT(*) as c FROM profile_documents WHERE profile_id = ?').get(p.id).c;
  
  let totalFields = 0;
  sections.forEach(s => {
    try {
      const data = JSON.parse(s.data || '{}');
      totalFields += Object.values(data).filter(v => v && v !== '' && (!Array.isArray(v) || v.length > 0)).length;
    } catch(e) {}
  });
  
  const name = p.display_name.substring(0, 32).padEnd(32);
  const type = (p.primary_type || 'individual').substring(0, 12).padEnd(12);
  console.log(`${name} | ${type} | ${String(sections.length).padStart(8)} | ${String(docCount).padStart(4)} | ${totalFields}`);
});

console.log('\n=== TOTAL ===');
console.log(`Profiles: ${profiles.length}`);
const totalDocs = db.prepare('SELECT COUNT(*) as c FROM documents').get().c;
console.log(`Documents: ${totalDocs}`);

db.close();
