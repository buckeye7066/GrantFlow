// Local-only test fixture: create a representative "Vermilion Church of God of
// Prophecy" (Vermilion, OH) church profile so the Crawler OS org path can be
// exercised locally. The real Vermilion COGOP profile lives in production.
const Database = require('better-sqlite3');
const db = new Database('backend/data/grantflow.db');
const pid = 'profile-vermilion-cogop';
const now = new Date().toISOString();

db.prepare(
  'INSERT OR REPLACE INTO profiles (id, primary_type, display_name, status, created_at, updated_at) VALUES (?,?,?,?,?,?)',
).run(pid, 'church', 'Vermilion Church of God of Prophecy', 'active', now, now);

const sections = {
  basic_information: { organization_name: 'Vermilion Church of God of Prophecy', organization_type: 'church', ein: '' },
  organization_details: {
    mission: 'A local congregation serving Vermilion, Ohio with worship, youth ministry, a food pantry, and community outreach programs.',
    nonprofit_type: 'church', staff_count: 4, annual_budget: 120000,
  },
  location_focus: { state: 'OH', city: 'Vermilion', postal_code: '44089', county: 'Erie', service_area: 'Vermilion and Erie County, Ohio' },
  narrative: { summary: 'We need funding for facility repairs, our food pantry, youth programs, and emergency community assistance. Faith-based 501(c)(3) religious organization.' },
};
const ins = db.prepare('INSERT OR REPLACE INTO profile_sections (id, profile_id, section_key, data, created_at, updated_at) VALUES (?,?,?,?,?,?)');
for (const [k, v] of Object.entries(sections)) ins.run(`${pid}:${k}`, pid, k, JSON.stringify(v), now, now);
console.log(`created ${pid} + ${Object.keys(sections).length} sections`);
