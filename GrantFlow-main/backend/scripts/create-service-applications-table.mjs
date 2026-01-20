import Database from 'better-sqlite3';

const db = new Database('./data/grantflow.db');

// Create service_applications table
db.exec(`
  CREATE TABLE IF NOT EXISTS service_applications (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    type TEXT NOT NULL DEFAULT 'service_application',
    full_name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT,
    organization TEXT,
    title TEXT,
    client_category TEXT,
    selected_services TEXT DEFAULT '[]',
    total_cost REAL,
    subject TEXT,
    message TEXT,
    status TEXT DEFAULT 'new' CHECK(status IN ('new', 'reviewed', 'contacted', 'converted', 'archived')),
    reviewed_by TEXT,
    reviewed_at DATETIME,
    notes TEXT,
    profile_id TEXT
  );
  
  CREATE INDEX IF NOT EXISTS idx_service_applications_status ON service_applications(status);
  CREATE INDEX IF NOT EXISTS idx_service_applications_created ON service_applications(created_at);
  CREATE INDEX IF NOT EXISTS idx_service_applications_email ON service_applications(email);
`);

console.log('✅ service_applications table created successfully!');

// Verify
const tableInfo = db.prepare('PRAGMA table_info(service_applications)').all();
console.log('Columns:', tableInfo.map(c => c.name).join(', '));

db.close();
