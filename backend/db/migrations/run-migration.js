/**
 * Database Migration Runner
 * Runs SQL migration files against the database
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Get database path from env or use default
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '../../data/grantflow.db');

console.log('=== Database Migration Runner ===\n');
console.log('Database:', DB_PATH);

// Ensure database exists
if (!fs.existsSync(DB_PATH)) {
  console.error('ERROR: Database file not found at:', DB_PATH);
  console.error('Please run the server first to create the database, or set DATABASE_PATH environment variable.');
  process.exit(1);
}

// Connect to database
const db = new Database(DB_PATH);

// Create migrations table if it doesn't exist
db.exec(`
  CREATE TABLE IF NOT EXISTS _migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Get list of applied migrations
const appliedMigrations = db.prepare('SELECT name FROM _migrations ORDER BY id').all();
const appliedSet = new Set(appliedMigrations.map(m => m.name));

console.log(`\nApplied migrations: ${appliedMigrations.length}`);
if (appliedMigrations.length > 0) {
  appliedMigrations.forEach(m => console.log(`  - ${m.name}`));
}

// Get list of migration files
const migrationsDir = __dirname;
const migrationFiles = fs.readdirSync(migrationsDir)
  .filter(f => f.endsWith('.sql'))
  .sort();

console.log(`\nAvailable migrations: ${migrationFiles.length}`);
migrationFiles.forEach(f => console.log(`  - ${f}`));

// Apply pending migrations
const pendingMigrations = migrationFiles.filter(f => !appliedSet.has(f));

if (pendingMigrations.length === 0) {
  console.log('\n✓ Database is up to date. No migrations to apply.');
  process.exit(0);
}

console.log(`\nPending migrations: ${pendingMigrations.length}`);
pendingMigrations.forEach(f => console.log(`  - ${f}`));

console.log('\nApplying migrations...\n');

const recordMigration = db.prepare('INSERT INTO _migrations (name) VALUES (?)');

for (const filename of pendingMigrations) {
  const migrationPath = path.join(migrationsDir, filename);
  const sql = fs.readFileSync(migrationPath, 'utf8');
  
  console.log(`Applying: ${filename}`);
  
  try {
    // Run migration in a transaction
    const migrate = db.transaction(() => {
      // Execute the migration SQL
      db.exec(sql);
      // Record that this migration was applied
      recordMigration.run(filename);
    });
    
    migrate();
    console.log(`  ✓ Success\n`);
  } catch (error) {
    console.error(`  ✗ Failed: ${error.message}\n`);
    process.exit(1);
  }
}

console.log('✓ All migrations applied successfully');

db.close();
