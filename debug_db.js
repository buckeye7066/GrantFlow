import Database from 'better-sqlite3';
import { join } from 'path';

const dbPath = join(process.cwd(), 'seed', 'grantflow.db');
const db = new Database(dbPath);

try {
  const profileCount = db.prepare('SELECT count(*) as count FROM profiles').get().count;
  console.log(`Total profiles: ${profileCount}`);
  
  if (profileCount > 0) {
    const samples = db.prepare('SELECT id, display_name, user_id FROM profiles LIMIT 5').all();
    console.log('Sample profiles:', JSON.stringify(samples, null, 2));
  }
  
  const userCount = db.prepare('SELECT count(*) as count FROM users').get().count;
  console.log(`Total users: ${userCount}`);
  
  const sessions = db.prepare('SELECT count(*) as count FROM user_sessions').get().count;
  console.log(`Total sessions: ${sessions}`);

} catch (err) {
  console.error('Error reading database:', err.message);
} finally {
  db.close();
}
