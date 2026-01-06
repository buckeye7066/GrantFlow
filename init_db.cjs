const Database = require('better-sqlite3');
const fs = require('fs');

const db = new Database('./seed/grantflow.db');

// Apply schema
const schema = fs.readFileSync('./backend/db/schema.sql', 'utf8');
db.exec(schema);

console.log('Schema applied successfully');

// List tables
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('Tables:', tables.map(t => t.name).join(', '));

// Check opportunity count
const oppCount = db.prepare('SELECT COUNT(*) as total FROM funding_opportunities').get();
console.log('Funding opportunities:', oppCount.total);

db.close();
