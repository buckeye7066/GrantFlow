import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

let Database = null
let dependencyError = null

try {
  Database = (await import('better-sqlite3')).default
} catch (error) {
  dependencyError = error
  Database = null
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const DB_PATH = path.resolve(__dirname, '..', 'data', 'grantflow.db')
const SCHEMA_PATH = path.join(__dirname, 'schema.sql')

let dbInstance = null

function ensureFundingSourceColumns(db) {
  const info = db.prepare('PRAGMA table_info(funding_sources)').all()
  const columns = new Set(info.map((column) => column.name))
  const additions = [
    { name: 'summary', type: 'TEXT' },
    { name: 'amount_min', type: 'REAL' },
    { name: 'amount_max', type: 'REAL' },
    { name: 'currency', type: "TEXT DEFAULT 'USD'" },
    { name: 'geography', type: 'TEXT' },
    { name: 'category', type: 'TEXT' },
    { name: 'tags', type: 'TEXT' },
    { name: 'eligibility', type: 'TEXT' },
    { name: 'source_id', type: 'TEXT' },
    { name: 'contact_email', type: 'TEXT' },
    { name: 'contact_phone', type: 'TEXT' },
    { name: 'last_synced_at', type: 'TEXT' },
  ]

  for (const addition of additions) {
    if (!columns.has(addition.name)) {
      db.exec(`ALTER TABLE funding_sources ADD COLUMN ${addition.name} ${addition.type}`)
    }
  }
}

function ensureProfileColumns(db) {
  const info = db.prepare('PRAGMA table_info(profiles)').all()
  const columns = new Set(info.map((column) => column.name))
  const additions = [
    { name: 'contact_email', definition: 'TEXT' },
    { name: 'contact_phone', definition: 'TEXT' },
    { name: 'website', definition: 'TEXT' },
    { name: 'mission_statement', definition: 'TEXT' },
    { name: 'ein', definition: 'TEXT' },
    { name: 'duns', definition: 'TEXT' },
    { name: 'cage_code', definition: 'TEXT' },
    { name: 'naics_codes', definition: 'TEXT' },
    { name: 'annual_budget', definition: 'REAL' },
    { name: 'staff_count', definition: 'INTEGER' },
    { name: 'volunteer_count', definition: 'INTEGER' },
    { name: 'service_area', definition: 'TEXT' },
    { name: 'demographics_served', definition: 'TEXT' },
    { name: 'program_focus_areas', definition: 'TEXT' },
    { name: 'compliance_notes', definition: 'TEXT' },
    { name: 'certifications', definition: 'TEXT' },
    { name: 'phi_access_required', definition: 'INTEGER DEFAULT 0' },
    { name: 'created_by', definition: 'TEXT' },
    { name: 'owner_id', definition: 'TEXT' },
    { name: 'case_manager_id', definition: 'TEXT' },
    { name: 'admin_id', definition: 'TEXT' },
    { name: 'last_contacted_at', definition: 'TEXT' },
    { name: 'status', definition: "TEXT DEFAULT 'active'" },
    { name: 'job_title', definition: 'TEXT' },
    { name: 'application_data', definition: 'TEXT' },
  ]

  for (const addition of additions) {
    if (!columns.has(addition.name)) {
      db.exec(`ALTER TABLE profiles ADD COLUMN ${addition.name} ${addition.definition}`)
    }
  }
}

function applyMigrations(db) {
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8')
  db.exec(schema)
  try {
    ensureProfileColumns(db)
    ensureFundingSourceColumns(db)
    seedDiscoveryDefaults(db)
  } catch (error) {
    // ignore if table does not exist yet
  }
}

function seedDiscoveryDefaults(db) {
  const insertSource = db.prepare(
    `INSERT INTO discovery_sources (
      id, name, description, type, region, status, schedule, last_run_at, last_success_at, success_count, failure_count, metadata_json
    ) VALUES (
      @id, @name, @description, @type, @region, @status, @schedule, @last_run_at, @last_success_at, @success_count, @failure_count, @metadata_json
    )`,
  )
  const existingSources = db.prepare('SELECT id FROM discovery_sources').all()
  if (existingSources.length === 0) {
    const now = new Date().toISOString()
    const defaults = [
      {
        id: 'source-grants-gov',
        name: 'Grants.gov',
        description: 'Federal grants index aggregated nightly for education, research, and healthcare opportunities.',
        type: 'federal',
        region: 'United States',
        status: 'active',
        schedule: '0 2 * * *',
        last_run_at: now,
        last_success_at: now,
        success_count: 42,
        failure_count: 1,
        metadata_json: JSON.stringify({ ingestionWindow: 'P7D', categories: ['STEM', 'Community Health'] }),
      },
      {
        id: 'source-foundation-center',
        name: 'Foundation Center',
        description: 'Private and community foundation opportunities with weekly refresh cadence.',
        type: 'foundation',
        region: 'North America',
        status: 'active',
        schedule: '30 3 * * 1',
        last_run_at: now,
        last_success_at: now,
        success_count: 17,
        failure_count: 0,
        metadata_json: JSON.stringify({ ingestionWindow: 'P30D', categories: ['Youth', 'Human Services'] }),
      },
      {
        id: 'source-regional-housing',
        name: 'Regional Housing Initiatives',
        description: 'Regional housing, infrastructure, and resilience grant programs monitored monthly.',
        type: 'state',
        region: 'Southeast US',
        status: 'idle',
        schedule: '0 6 1 * *',
        last_run_at: null,
        last_success_at: null,
        success_count: 0,
        failure_count: 0,
        metadata_json: JSON.stringify({ ingestionWindow: 'P90D', categories: ['Infrastructure', 'Resilience'] }),
      },
    ]
    const transaction = db.transaction((sources) => {
      for (const source of sources) {
        insertSource.run(source)
      }
    })
    transaction(defaults)
  }

  const existingTemplates = db.prepare('SELECT id FROM discovery_templates').all()
  if (existingTemplates.length === 0) {
    const templateInsert = db.prepare(
      `INSERT INTO discovery_templates (
        id, name, description, query, filters_json, owner_id, is_default, created_at, updated_at
      ) VALUES (
        @id, @name, @description, @query, @filters_json, @owner_id, @is_default, @created_at, @updated_at
      )`,
    )
    const now = new Date().toISOString()
    const templates = [
      {
        id: 'tmpl-stem-workforce',
        name: 'STEM Workforce Development',
        description: 'Federal and foundation grants focused on STEM training and workforce readiness for youth and adults.',
        query: 'STEM workforce training technology education',
        filters_json: JSON.stringify({ category: 'STEM', geography: 'United States', tags: ['education', 'workforce'] }),
        owner_id: null,
        is_default: 1,
        created_at: now,
        updated_at: now,
      },
      {
        id: 'tmpl-community-health',
        name: 'Community Health Equity',
        description: 'Opportunities supporting rural health, telehealth, and behavioral health services.',
        query: 'community health equity telehealth behavioral',
        filters_json: JSON.stringify({ category: 'Health', geography: 'Southeast US', tags: ['rural', 'behavioral health'] }),
        owner_id: null,
        is_default: 1,
        created_at: now,
        updated_at: now,
      },
      {
        id: 'tmpl-infrastructure-resilience',
        name: 'Infrastructure & Resilience',
        description: 'Funding for broadband, water systems, and disaster resilience projects.',
        query: 'infrastructure broadband resilience water utilities',
        filters_json: JSON.stringify({ category: 'Infrastructure', geography: 'North America', tags: ['resilience', 'infrastructure'] }),
        owner_id: null,
        is_default: 1,
        created_at: now,
        updated_at: now,
      },
    ]
    const transaction = db.transaction((rows) => {
      for (const row of rows) {
        templateInsert.run(row)
      }
    })
    transaction(templates)
  }

  const opportunityCount = db.prepare('SELECT COUNT(*) as count FROM funding_sources').get().count
  if (opportunityCount === 0) {
    const now = new Date().toISOString()
    const insertOpportunity = db.prepare(
      `INSERT INTO funding_sources (
        id, title, summary, description, amount_min, amount_max, currency, deadline, geography,
        category, tags, eligibility, source_id, contact_email, contact_phone, source_url,
        last_synced_at, created_at, updated_at
      ) VALUES (
        @id, @title, @summary, @description, @amount_min, @amount_max, @currency, @deadline,
        @geography, @category, @tags, @eligibility, @source_id, @contact_email, @contact_phone,
        @source_url, @last_synced_at, @created_at, @updated_at
      )`,
    )
    const seedOpportunities = [
      {
        id: 'opp-stem-accelerator',
        title: 'Regional STEM Accelerator Grants',
        summary: 'Up to $250K to launch or expand STEM workforce training programs in underserved communities.',
        description:
          'Supports collaboration between educational institutions, employers, and community partners to create hands-on STEM workforce programs serving rural and underserved populations.',
        amount_min: 50000,
        amount_max: 250000,
        currency: 'USD',
        deadline: new Date(Date.now() + 1000 * 60 * 60 * 24 * 60).toISOString(),
        geography: 'Southeast US',
        category: 'STEM Education',
        tags: 'STEM,workforce,education,rural',
        eligibility: 'Nonprofit organizations, community colleges, and workforce development agencies.',
        source_id: 'source-grants-gov',
        contact_email: 'grants@grantflow.io',
        contact_phone: '+1-555-0101',
        source_url: 'https://www.grants.gov/stem-accelerator',
        last_synced_at: now,
        created_at: now,
        updated_at: now,
      },
      {
        id: 'opp-health-equity-innovators',
        title: 'Health Equity Innovation Fund',
        summary: 'Supports initiatives expanding access to telehealth and behavioral health services.',
        description:
          'Funding for community-based organizations improving health outcomes through telehealth, mental health services, and culturally responsive care models.',
        amount_min: 75000,
        amount_max: 300000,
        currency: 'USD',
        deadline: new Date(Date.now() + 1000 * 60 * 60 * 24 * 45).toISOString(),
        geography: 'United States',
        category: 'Health',
        tags: 'telehealth,behavioral health,community health',
        eligibility: '501(c)(3) nonprofits and public health entities serving rural or underserved populations.',
        source_id: 'source-foundation-center',
        contact_email: 'healthgrants@foundation.org',
        contact_phone: '+1-555-2211',
        source_url: 'https://foundation.org/health-equity',
        last_synced_at: now,
        created_at: now,
        updated_at: now,
      },
      {
        id: 'opp-infra-resilience-2024',
        title: 'Community Infrastructure & Resilience Challenge',
        summary: 'Funding to modernize critical infrastructure and improve climate resilience.',
        description:
          'Competitive grants for municipalities investing in resilient water, transportation, and broadband infrastructure, including climate mitigation components.',
        amount_min: 150000,
        amount_max: 500000,
        currency: 'USD',
        deadline: new Date(Date.now() + 1000 * 60 * 60 * 24 * 90).toISOString(),
        geography: 'Appalachian Region',
        category: 'Infrastructure',
        tags: 'infrastructure,resilience,climate,broadband',
        eligibility: 'City and county governments, public utilities, tribal governments.',
        source_id: 'source-regional-housing',
        contact_email: 'infrastructure@state.gov',
        contact_phone: '+1-555-7788',
        source_url: 'https://state.gov/infrastructure-challenge',
        last_synced_at: now,
        created_at: now,
        updated_at: now,
      },
    ]
    const insertTx = db.transaction((rows) => {
      for (const row of rows) {
        insertOpportunity.run(row)
      }
    })
    insertTx(seedOpportunities)
  }
}

export function getDb() {
  if (!Database) {
    const message =
      'better-sqlite3 dependency is missing. Install it with "npm install better-sqlite3" to enable profile/document persistence.'
    const error = dependencyError ?? new Error(message)
    error.status = 500
    throw error
  }

  if (!dbInstance) {
    dbInstance = new Database(DB_PATH)
    dbInstance.pragma('journal_mode = WAL')
    applyMigrations(dbInstance)
  }
  return dbInstance
}

export function initDb() {
  // Initialize database if available
  if (isDatabaseAvailable()) {
    try {
      getDb()
    } catch (error) {
      console.error('Failed to initialize database:', error)
    }
  }
}

export function isDatabaseAvailable() {
  return Boolean(Database)
}

export function closeDb() {
  if (dbInstance) {
    dbInstance.close()
    dbInstance = null
  }
}
