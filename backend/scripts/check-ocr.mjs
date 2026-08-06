import Database from 'better-sqlite3';

const db = new Database('./data/grantflow.db');

const result = db.prepare(`
  SELECT d.extracted_text FROM documents d
  JOIN profiles p ON d.profile_id = p.id
  WHERE p.display_name LIKE '%Demo Student%'
`).get();

console.log('=== OCR TEXT CAPTURED ===\n');
console.log(result?.extracted_text || 'No text found');
console.log('\n=== END ===');

db.close();
