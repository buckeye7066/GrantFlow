import Database from 'better-sqlite3';

const db = new Database('./data/grantflow.db');

console.log('=== CRAWLER JOBS STATUS ===\n');

// Check total jobs
const total = db.prepare('SELECT COUNT(*) as c FROM crawler_jobs').get().c;
console.log('Total crawler jobs:', total);

if (total > 0) {
  // Jobs by status
  const byStatus = db.prepare('SELECT status, COUNT(*) as c FROM crawler_jobs GROUP BY status').all();
  console.log('\nBy Status:');
  byStatus.forEach(s => console.log(`  ${s.status}: ${s.c}`));

  // Jobs by type
  const byType = db.prepare('SELECT type, COUNT(*) as c FROM crawler_jobs GROUP BY type').all();
  console.log('\nBy Type:');
  byType.forEach(t => console.log(`  ${t.type}: ${t.c}`));

  // Jobs by profile
  console.log('\nBy Profile:');
  const byProfile = db.prepare(`
    SELECT p.display_name, COUNT(cj.id) as jobs, 
           SUM(CASE WHEN cj.status = 'completed' THEN 1 ELSE 0 END) as completed
    FROM profiles p
    LEFT JOIN crawler_jobs cj ON p.id = cj.profile_id
    GROUP BY p.id
    ORDER BY p.display_name
  `).all();
  byProfile.forEach(p => console.log(`  ${p.display_name}: ${p.jobs} jobs (${p.completed} completed)`));
} else {
  console.log('\n⚠️  NO CRAWLER JOBS HAVE BEEN RUN YET!');
  console.log('\nProfiles that need crawlers:');
  const profiles = db.prepare('SELECT display_name FROM profiles ORDER BY display_name').all();
  profiles.forEach(p => console.log(`  ❌ ${p.display_name}`));
}

db.close();
