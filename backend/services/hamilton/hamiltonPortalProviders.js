/**
 * hamiltonPortalProviders.js
 *
 * Replacement default provider catalogue. The legacy
 * schoolPortalImportService treated every provider as
 * `pilot_manual_import` with `live_supported = false`. That has been
 * the actual primary product behavior, but Hamilton Autopilot now ships
 * real automation modes alongside manual import:
 *
 *   - pilot_manual_import         — paste/upload export from portal (legacy)
 *   - browser_autopilot           — Hamilton drives the portal unattended
 *   - browser_session_reuse       — reuse a saved Playwright storageState
 *   - secure_credential_reference — credentials live in a secure vault
 *   - api_integration             — direct provider API
 *
 * The provider catalogue is editable: a row in `hamilton_portal_providers`
 * overrides the seeded default. This module returns the merged view.
 */

const SEED_PROVIDERS = Object.freeze([
  Object.freeze({
    id: 'tsac',
    name: 'Tennessee Student Assistance Corporation (TSAC)',
    short_name: 'TSAC',
    // Legacy tn.gov/collegepays.html now 302-redirects to the "College for TN"
    // (collegefortn.org) site run by THEC. Use the live landing page.
    portal_url: 'https://www.collegefortn.org/about-financial-aid/',
    integration_modes: ['pilot_manual_import', 'browser_autopilot'],
    live_supported: true,
    automation_supported: true,
    authentication_strategy: 'username_password',
    session_reuse_supported: true,
    credential_reference_supported: false,
    captcha_likely: false,
    two_factor_likely: false,
    tos_notes: 'Public scholarship portal. Hamilton uses standard form completion only.',
    adapter_name: 'genericScholarshipPortalAdapter',
    notes: 'Manual import remains as fallback; Autopilot runs against the public application form.',
  }),
  Object.freeze({
    id: 'mtsu',
    name: 'Middle Tennessee State University',
    short_name: 'MTSU',
    portal_url: 'https://www.mtsu.edu/financial-aid/',
    integration_modes: ['browser_autopilot', 'browser_session_reuse'],
    live_supported: true,
    automation_supported: true,
    authentication_strategy: 'sso',
    session_reuse_supported: true,
    credential_reference_supported: true,
    captcha_likely: false,
    two_factor_likely: true,
    tos_notes: 'University SSO. Hamilton stops for 2FA unless an active session is reused.',
    adapter_name: 'genericUniversityFinancialAidAdapter',
  }),
  Object.freeze({
    // Scaffolded by mirroring the MTSU entry. The specific apply-flow
    // selectors and SSO login steps for Cleveland State must be validated
    // against the live CSCC portal after a real session is captured.
    id: 'cscc',
    name: 'Cleveland State Community College',
    short_name: 'CSCC',
    portal_url: 'https://www.clevelandstatecc.edu/admissions-aid/financial-aid',
    integration_modes: ['browser_autopilot', 'browser_session_reuse'],
    live_supported: true,
    automation_supported: true,
    authentication_strategy: 'sso',
    session_reuse_supported: true,
    credential_reference_supported: true,
    captcha_likely: false,
    two_factor_likely: true,
    tos_notes: 'Community college SSO. Hamilton stops for 2FA unless an active session is reused.',
    adapter_name: 'genericUniversityFinancialAidAdapter',
  }),
  Object.freeze({
    id: 'fafsa',
    name: 'Free Application for Federal Student Aid',
    short_name: 'FAFSA',
    portal_url: 'https://studentaid.gov/h/apply-for-aid/fafsa',
    integration_modes: ['secure_credential_reference', 'browser_session_reuse'],
    live_supported: true,
    automation_supported: true,
    authentication_strategy: 'fsa_id',
    session_reuse_supported: true,
    credential_reference_supported: true,
    captcha_likely: false,
    two_factor_likely: true,
    tos_notes: 'Federal site. Hamilton never types an FSA ID password — relies on saved session or vault reference.',
    adapter_name: 'genericUniversityFinancialAidAdapter',
  }),
  Object.freeze({
    id: 'common_app',
    name: 'Common Application',
    short_name: 'CommonApp',
    portal_url: 'https://www.commonapp.org/',
    integration_modes: ['browser_autopilot'],
    live_supported: true,
    automation_supported: true,
    authentication_strategy: 'username_password',
    session_reuse_supported: true,
    credential_reference_supported: true,
    captcha_likely: true,
    two_factor_likely: false,
    tos_notes: 'CAPTCHA likely on first login. Hamilton stops for CAPTCHA.',
    adapter_name: 'genericAdmissionsPortalAdapter',
  }),
])

// Per-db schema cache (WeakMap), not a process-global boolean: node:test runs a
// file's top-level suites concurrently, each with its own in-memory db, and a
// shared boolean races (one suite marks ready, a sibling's fresh db then skips
// schema creation). Keying by db keeps each db independent; prod (one db) is
// unchanged. Mirrors agentControlStore.
let schemaReady = new WeakMap()
async function ensureSchema(db) {
  if (!db || schemaReady.has(db) || typeof db.prepare !== 'function') return
  const isPostgres = db?.dialect === 'postgres'
  const boolType = isPostgres ? 'BOOLEAN' : 'INTEGER'
  const tsType = isPostgres ? 'TIMESTAMPTZ' : 'DATETIME'
  const nowFn = isPostgres ? 'now()' : 'CURRENT_TIMESTAMP'
  await db.exec(`
    CREATE TABLE IF NOT EXISTS hamilton_portal_providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      short_name TEXT,
      portal_url TEXT,
      integration_modes TEXT NOT NULL DEFAULT 'pilot_manual_import',
      live_supported ${boolType} NOT NULL DEFAULT 0,
      automation_supported ${boolType} NOT NULL DEFAULT 0,
      authentication_strategy TEXT,
      session_reuse_supported ${boolType} NOT NULL DEFAULT 0,
      credential_reference_supported ${boolType} NOT NULL DEFAULT 0,
      captcha_likely ${boolType} NOT NULL DEFAULT 0,
      two_factor_likely ${boolType} NOT NULL DEFAULT 0,
      tos_notes TEXT,
      adapter_name TEXT,
      notes TEXT,
      created_at ${tsType} DEFAULT ${nowFn},
      updated_at ${tsType} DEFAULT ${nowFn}
    )
  `)
  schemaReady.set(db, true)
}

function normalizeRow(row) {
  return {
    id: row.id,
    name: row.name,
    short_name: row.short_name || null,
    portal_url: row.portal_url || null,
    integration_modes: typeof row.integration_modes === 'string'
      ? row.integration_modes.split(',').map((s) => s.trim()).filter(Boolean)
      : row.integration_modes || [],
    live_supported: !!row.live_supported,
    automation_supported: !!row.automation_supported,
    authentication_strategy: row.authentication_strategy || null,
    session_reuse_supported: !!row.session_reuse_supported,
    credential_reference_supported: !!row.credential_reference_supported,
    captcha_likely: !!row.captcha_likely,
    two_factor_likely: !!row.two_factor_likely,
    tos_notes: row.tos_notes || null,
    adapter_name: row.adapter_name || null,
    notes: row.notes || null,
  }
}

export async function listPortalProviders(db) {
  if (!db) return SEED_PROVIDERS.map((p) => ({ ...p }))
  await ensureSchema(db)
  let rows = []
  try {
    rows = await db.prepare('SELECT * FROM hamilton_portal_providers').all()
  } catch { rows = [] }
  const overrides = new Map((rows || []).map((r) => [String(r.id), normalizeRow(r)]))
  return SEED_PROVIDERS.map((seed) => {
    const override = overrides.get(seed.id)
    return override ? { ...seed, ...override } : { ...seed }
  })
    .concat([...overrides.values()].filter((o) => !SEED_PROVIDERS.find((s) => s.id === o.id)))
}

export async function getPortalProvider(db, id) {
  const list = await listPortalProviders(db)
  return list.find((p) => p.id === id) || null
}

export const HAMILTON_INTEGRATION_MODES = Object.freeze([
  'pilot_manual_import',
  'browser_autopilot',
  'browser_session_reuse',
  'secure_credential_reference',
  'api_integration',
])
