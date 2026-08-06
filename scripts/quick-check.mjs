import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { writeFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const dbPath = join(__dirname, '..', 'backend', 'data', 'grantflow.db');

const output = [];

function log(msg) {
  const line = String(msg);
  console.log(line);
  output.push(line);
}

try {
  log('=== QUICK CHECK ===');
  log(`Database: ${dbPath}`);
  
  const db = new Database(dbPath);
  log('✓ Database connected');
  
  // Check profiles
  const profiles = db.prepare('SELECT id, display_name, user_id FROM profiles ORDER BY display_name').all();
  log(`\nFound ${profiles.length} profiles:`);
  
  let linked = 0;
  let unlinked = 0;
  
  profiles.forEach(p => {
    if (p.user_id) {
      linked++;
      const user = db.prepare('SELECT display_name, primary_email FROM users WHERE id = ?').get(p.user_id);
      log(`  ✓ ${p.display_name.padEnd(25)} → ${user?.display_name || 'Unknown'} (${user?.primary_email || 'N/A'})`);
    } else {
      unlinked++;
      log(`  ✗ ${p.display_name.padEnd(25)} → NOT LINKED`);
    }
  });
  
  log(`\nSummary: ${linked} linked, ${unlinked} unlinked`);
  
  db.close();
  
  // Write output
  writeFileSync(join(__dirname, '..', 'quick-check-output.txt'), output.join('\n'));
  log('\n✓ Output written to quick-check-output.txt');
  
} catch (error) {
  log(`ERROR: ${error.message}`);
  log(error.stack);
  writeFileSync(join(__dirname, '..', 'quick-check-error.txt'), error.message + '\n' + error.stack);
  process.exit(1);
}
