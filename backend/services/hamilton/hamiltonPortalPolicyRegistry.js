/**
 * hamiltonPortalPolicyRegistry.js
 *
 * Per-host policy registry: tells Hamilton whether automation is permitted
 * on a given portal, what the lawful fallback path is when it isn't,
 * and (if available) the official API to use instead of the browser.
 *
 * Hamilton NEVER ignores an explicit terms-prohibit-automation rule. When
 * a portal disallows automation she switches to the fallback_path —
 * pdf_docx packet, mail, fax, email, manual instructions, or API.
 *
 * Seed entries cover the well-known portals; per-host overrides live
 * in the `hamilton_portal_policies` table and win over the seed.
 */

import crypto from 'node:crypto'
import { normalizeHost } from './hamiltonCredentialSessionService.js'

// Per-db schema cache (WeakMap), not a process-global boolean: node:test runs a
// file's top-level suites concurrently, each with its own in-memory db, and a
// shared boolean races (one suite marks ready, a sibling's fresh db then skips
// schema creation). Keying by db keeps each db independent; prod (one db) is
// unchanged. Mirrors agentControlStore.
let schemaReady = new WeakMap()
export function _resetPortalPolicySchemaCache() { schemaReady = new WeakMap() }

/**
 * IDENTITY-PROOFED hosts: portals that gate account creation behind real
 * identity verification (SSN match, government ID, knowledge-based auth, ID.me /
 * Login.gov IAL2 proofing, FSA ID). Hamilton may ATTEMPT them, but she must NOT
 * fabricate identity / SSN / government-ID proofing (keep-me-legal). When
 * registration hits one of these walls she hands off to the human session-capture
 * flow and marks the portal "needs you" — a graceful handoff, not a failure.
 *
 * Matched on registrable domain via isIdentityProofedHost (so id.me, login.gov,
 * any *.studentaid.gov, etc. are covered). The list is intentionally
 * conservative — when in doubt the registration engine ALSO treats any
 * identity-proofing wall surfaced at runtime (via hamiltonBlockerClassifier) the
 * same way, so unlisted proofing portals still fall back gracefully.
 */
export const IDENTITY_PROOFED_HOSTS = Object.freeze([
  'studentaid.gov', // FSA ID — SSN + identity match
  'login.gov',      // federal shared sign-in, IAL2 identity proofing
  'id.me',          // identity verification provider (gov / VA / IRS)
  'irs.gov',        // ID.me / KBA identity proofing
  'ssa.gov',        // Social Security — KBA identity proofing
  'va.gov',         // VA — Login.gov / ID.me proofing
  'medicare.gov',   // identity-proofed account creation
  'healthcare.gov', // identity verification for marketplace accounts
  'sam.gov',        // entity / Login.gov IAL2 proofing
  'connect.gov',
])

/**
 * Is this host an identity-proofed portal (account creation needs real identity
 * verification)? Registrable-domain match so subdomains are covered.
 */
export function isIdentityProofedHost(portalHost) {
  const host = normalizeHost(portalHost)
  if (!host) return false
  return IDENTITY_PROOFED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
}

const SEED_POLICIES = Object.freeze([
  Object.freeze({
    portal_host: 'studentaid.gov',
    automation_allowed: false,           // FSA-ID terms forbid agent automation
    agent_submission_allowed: false,
    scraping_allowed: false,
    api_available: false,
    manual_only: true,
    identity_proofed: true,
    fallback_path: 'manual',
    source_of_policy: 'https://studentaid.gov/help/terms-of-service',
    notes: 'Hamilton never types an FSA ID or submits FAFSA on behalf of the student. Use saved authenticated session only when the user authorized session reuse, otherwise produce a manual checklist.',
  }),
  Object.freeze({
    portal_host: 'commonapp.org',
    automation_allowed: false,
    agent_submission_allowed: false,
    scraping_allowed: false,
    api_available: false,
    manual_only: true,
    fallback_path: 'manual',
    source_of_policy: 'https://www.commonapp.org/terms-of-use',
    notes: 'Common App ToS forbids third-party agent submission. Hamilton produces a printable preparation packet only.',
  }),
  Object.freeze({
    portal_host: 'tn.gov',
    automation_allowed: true,
    agent_submission_allowed: true,
    scraping_allowed: false,
    api_available: false,
    manual_only: false,
    fallback_path: 'pdf_docx',
    source_of_policy: 'https://www.tn.gov/about-tn/policies.html',
    notes: 'Public scholarship application form. Standard form completion only.',
  }),
  Object.freeze({
    // TSAC's CollegePays portal moved from tn.gov to the "College for TN"
    // (collegefortn.org) site run by THEC. Same public scholarship/aid
    // application surface, same policy as the legacy tn.gov entry.
    portal_host: 'collegefortn.org',
    automation_allowed: true,
    agent_submission_allowed: true,
    scraping_allowed: false,
    api_available: false,
    manual_only: false,
    fallback_path: 'pdf_docx',
    source_of_policy: 'https://www.collegefortn.org/',
    notes: 'Public TSAC / College for TN scholarship application surface. Standard form completion only.',
  }),
  Object.freeze({
    portal_host: 'mtsu.edu',
    automation_allowed: true,
    agent_submission_allowed: true,
    scraping_allowed: false,
    api_available: false,
    manual_only: false,
    fallback_path: 'pdf_docx',
    notes: 'University SSO required; rely on saved session when reuse is authorized.',
  }),
  Object.freeze({
    // benefits.gov is a federal benefit FINDER — informational article/
    // directory pages only. There is no application portal anywhere on the
    // host (each benefit is applied for on the administering agency's own
    // site), so a task pointing here is unsubmittable by design. Route it to
    // the manual/packet path instead of ever driving a browser at it.
    portal_host: 'benefits.gov',
    automation_allowed: false,
    agent_submission_allowed: false,
    scraping_allowed: false,
    api_available: false,
    manual_only: true,
    fallback_path: 'manual',
    source_of_policy: 'https://www.benefits.gov/',
    notes: 'Informational benefit directory with no application surface. Hamilton produces guidance/packet material; the actual application happens on the administering agency\'s site.',
  }),
  Object.freeze({
    // medicaid.gov hosts program information and policy articles only —
    // Medicaid/CHIP applications are filed with the state Medicaid agency or
    // via healthcare.gov, never on medicaid.gov itself. Same reasoning as
    // benefits.gov: info pages queued as "portals" must degrade to the packet
    // path, not the login flow. (studentaid.gov article pages are already
    // covered by its manual-only entry above.)
    portal_host: 'medicaid.gov',
    automation_allowed: false,
    agent_submission_allowed: false,
    scraping_allowed: false,
    api_available: false,
    manual_only: true,
    fallback_path: 'manual',
    source_of_policy: 'https://www.medicaid.gov/',
    notes: 'Informational program pages only — applications go through the state Medicaid agency or healthcare.gov. Hamilton produces guidance/packet material instead of browser automation.',
  }),
  Object.freeze({
    // Mirrors the mtsu.edu school entry. Cleveland State Community College
    // uses portal SSO; policy specifics should be re-verified against the
    // live CSCC portal once a session is captured.
    portal_host: 'clevelandstatecc.edu',
    automation_allowed: true,
    agent_submission_allowed: true,
    scraping_allowed: false,
    api_available: false,
    manual_only: false,
    fallback_path: 'pdf_docx',
    notes: 'Community college SSO required; rely on saved session when reuse is authorized.',
  }),
])

async function ensureSchema(db) {
  if (!db || schemaReady.has(db) || typeof db.prepare !== 'function') return
  const isPostgres = db?.dialect === 'postgres'
  const idDefault = isPostgres ? '(gen_random_uuid()::text)' : '(lower(hex(randomblob(16))))'
  const tsType = isPostgres ? 'TIMESTAMPTZ' : 'DATETIME'
  const nowFn = isPostgres ? 'now()' : 'CURRENT_TIMESTAMP'
  const boolType = isPostgres ? 'BOOLEAN' : 'INTEGER'
  const trueDef = isPostgres ? 'TRUE' : '1'
  const falseDef = isPostgres ? 'FALSE' : '0'
  const jsonType = isPostgres ? 'JSONB' : 'TEXT'
  const emptyObj = isPostgres ? `'{}'::jsonb` : `'{}'`
  await db.exec(`
    CREATE TABLE IF NOT EXISTS hamilton_portal_policies (
      id TEXT PRIMARY KEY DEFAULT ${idDefault},
      portal_host TEXT NOT NULL UNIQUE,
      automation_allowed ${boolType} NOT NULL DEFAULT ${trueDef},
      agent_submission_allowed ${boolType} NOT NULL DEFAULT ${trueDef},
      scraping_allowed ${boolType} NOT NULL DEFAULT ${falseDef},
      api_available ${boolType} NOT NULL DEFAULT ${falseDef},
      manual_only ${boolType} NOT NULL DEFAULT ${falseDef},
      fallback_path TEXT,
      source_of_policy TEXT,
      last_checked_at ${tsType},
      notes TEXT,
      metadata_json ${jsonType} NOT NULL DEFAULT ${emptyObj},
      created_at ${tsType} DEFAULT ${nowFn},
      updated_at ${tsType} DEFAULT ${nowFn}
    );
    CREATE INDEX IF NOT EXISTS idx_hamilton_policy_host ON hamilton_portal_policies(portal_host);
  `)
  schemaReady.set(db, true)
}

// A learned datacenter/IP-reputation wall is re-probed after this long, so a
// block that later lifts (the funder's WAF relaxes, our egress IP rotates) is
// not a permanent life sentence for the portal — the next attempt after the TTL
// tries the real browser once more and either re-confirms or self-heals.
export const WALL_REPROBE_MS = Number(process.env.PORTAL_WALL_REPROBE_MS) || 7 * 24 * 60 * 60 * 1000

// Parse whatever the driver handed back for metadata_json into a plain object.
// SQLite returns TEXT (JSON string); the Postgres shim may already return a
// JSONB object. Never throws — a corrupt value degrades to {}.
function parseMetadata(raw) {
  if (!raw) return {}
  if (typeof raw === 'object') return raw
  try { const v = JSON.parse(raw); return v && typeof v === 'object' ? v : {} } catch { return {} }
}

function rowToPolicy(row) {
  if (!row) return null
  const metadata = parseMetadata(row.metadata_json)
  const policy = {
    portal_host: row.portal_host,
    automation_allowed: !!row.automation_allowed,
    agent_submission_allowed: !!row.agent_submission_allowed,
    scraping_allowed: !!row.scraping_allowed,
    api_available: !!row.api_available,
    manual_only: !!row.manual_only,
    // Identity-proofed = account creation needs real identity verification. A DB
    // override can't currently store this flag, so OR it with the canonical host
    // list — a host on IDENTITY_PROOFED_HOSTS is always identity-proofed.
    identity_proofed: !!row.identity_proofed || isIdentityProofedHost(row.portal_host),
    fallback_path: row.fallback_path || null,
    source_of_policy: row.source_of_policy || null,
    last_checked_at: row.last_checked_at || null,
    notes: row.notes || null,
    metadata,
    submission_adapter: metadata.submission_adapter || null,
    // A learned server-side (datacenter-IP / anti-bot) wall, if one has been
    // observed. { state, category, signal, engine, first_seen_at, last_seen_at,
    // hits, cleared_at } or null.
    datacenter_block: metadata.datacenter_block || null,
  }
  policy.submission_mode = getReviewedSubmissionAdapter(policy) ? 'reviewed_auto_submit' : 'draft_only'
  return policy
}

/**
 * Find the policy that matches `portalHost`. Tries an exact host
 * match first, then walks up the registered domain (mtsu.edu →
 * tn.gov fallback, etc.). Falls back to the seed catalogue if there's
 * no DB row, then returns a permissive default if nothing matches.
 */
export async function getPolicyFor(db, portalHost) {
  const host = normalizeHost(portalHost)
  if (!host) return defaultPolicy(null)
  if (db) {
    await ensureSchema(db)
    const row = await db.prepare('SELECT * FROM hamilton_portal_policies WHERE portal_host = ? LIMIT 1').get(host)
    if (row) return rowToPolicy(row)
    // Suffix match: "wwww.mtsu.edu" should match "mtsu.edu".
    const parts = host.split('.')
    for (let i = 1; i < parts.length - 1; i += 1) {
      const suffix = parts.slice(i).join('.')
      const r = await db.prepare('SELECT * FROM hamilton_portal_policies WHERE portal_host = ? LIMIT 1').get(suffix)
      if (r) return rowToPolicy(r)
    }
  }
  // Seed catalogue.
  const seed = SEED_POLICIES.find((p) => p.portal_host === host)
    || SEED_POLICIES.find((p) => host.endsWith(`.${p.portal_host}`))
  if (seed) return {
    ...seed,
    identity_proofed: !!seed.identity_proofed || isIdentityProofedHost(host),
    submission_adapter: null,
    submission_mode: 'draft_only',
  }
  return defaultPolicy(host)
}

function defaultPolicy(host) {
  return {
    portal_host: host,
    automation_allowed: true,
    agent_submission_allowed: false,
    scraping_allowed: false,
    api_available: false,
    manual_only: false,
    // Even with no host-specific policy row, a canonical identity-proofed host
    // is still flagged so the autopilot identity engine hands off gracefully.
    identity_proofed: isIdentityProofedHost(host),
    fallback_path: 'pdf_docx',
    source_of_policy: null,
    last_checked_at: null,
    notes: 'Preparation may proceed, but external submission is human-only until a reviewed, fixture-backed portal adapter is registered.',
    submission_adapter: null,
    submission_mode: 'draft_only',
  }
}

/**
 * A portal may be auto-submitted only through a reviewed adapter whose exact
 * implementation/policy and fixture contract are frozen in policy metadata.
 * Merely setting agent_submission_allowed is not enough.
 */
export function getReviewedSubmissionAdapter(policy, { portalUrl = null } = {}) {
  if (!policy || policy.agent_submission_allowed !== true) return null
  const adapter = policy.submission_adapter || policy.metadata?.submission_adapter
  if (!adapter || adapter.reviewed !== true) return null
  if (adapter.enabled !== true || adapter.kill_switch === true) return null
  if (!adapter.id || !adapter.version || !adapter.reviewed_at) return null
  const syntheticFixtureOnly = adapterHostEndsInvalid(adapter)
  if (syntheticFixtureOnly) {
    if (adapter.operator_validation_version !== 'hamilton-adapter-fixtures-v1'
        || adapter.synthetic_fixture_only !== true) return null
  } else if (adapter.operator_validation_version !== 'hamilton-adapter-operator-validation-v1'
      || !adapter.operator_validation_artifact_id
      || !/^[a-f0-9]{64}$/i.test(String(adapter.operator_validation_evidence_sha256 || ''))
      || !['sandbox', 'training'].includes(String(adapter.operator_validation_environment || ''))
      || !Number.isFinite(Date.parse(adapter.operator_validation_expires_at))
      || Date.parse(adapter.operator_validation_expires_at) <= Date.now()) return null
  if (!/^[a-f0-9]{64}$/i.test(String(adapter.fixture_contract_sha256 || ''))) return null
  if (adapter.mode !== 'typed_receipt_v1') return null
  if (!['application', 'workspace', 'submission'].includes(adapter.application_identity_kind)) return null
  const adapterHost = normalizeHost(adapter.portal_host)
  if (!adapterHost || adapterHost !== normalizeHost(policy.portal_host)) return null
  if (!Array.isArray(adapter.allowed_origins) || !adapter.allowed_origins.includes(`https://${adapterHost}`)) return null
  for (const origin of adapter.allowed_origins) {
    try {
      const parsed = new URL(String(origin))
      if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== normalizeHost(parsed.hostname)
          || Boolean(parsed.port && parsed.port !== '443') || parsed.pathname !== '/'
          || Boolean(parsed.search || parsed.hash || parsed.username || parsed.password)) return null
    } catch { return null }
  }
  if (!adapter.submit_control?.selector || !/^[a-f0-9]{64}$/i.test(String(adapter.submit_control?.exact_text_sha256 || ''))) return null
  if (!adapter.receipt?.container_selector || !adapter.receipt?.identity_selector || !adapter.receipt?.identity_attribute) return null
  if (adapter.field_contract?.version !== 'exact-fields-v1'
      || !Array.isArray(adapter.field_contract?.fields)
      || adapter.field_contract.fields.length === 0) return null
  if (adapter.reconciliation_mode !== 'authenticated_exact_application_lookup_v1'
      || adapter.status_query?.mode !== 'authenticated_dom_exact_query_v1'
      || !adapter.status_query?.query_parameter
      || !String(adapter.status_query?.path_prefix || '').startsWith('/')
      || !adapter.status_query?.container_selector
      || !adapter.status_query?.status_selector
      || !adapter.status_query?.identity_selector
      || !adapter.status_query?.identity_attribute
      || !adapter.status_query?.received_states?.length
      || !adapter.status_query?.absent_states?.length) return null
  const boundedPath = (value) => {
    const path = String(value || '').replace(/\/+$/, '') || '/'
    return path.startsWith('/') && path !== '/' && !path.includes('?') && !path.includes('#')
  }
  if (!Array.isArray(adapter.allowed_path_prefixes) || adapter.allowed_path_prefixes.length === 0
      || adapter.allowed_path_prefixes.some((path) => !boundedPath(path))
      || !Array.isArray(adapter.auth_path_prefixes)
      || adapter.auth_path_prefixes.some((path) => !boundedPath(path))
      || !boundedPath(adapter.status_query.path_prefix)) return null
  if (portalUrl && Array.isArray(adapter.allowed_path_prefixes) && adapter.allowed_path_prefixes.length > 0) {
    let path
    try {
      const parsed = new URL(portalUrl)
      if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== adapterHost
          || Boolean(parsed.port && parsed.port !== '443') || parsed.username || parsed.password) return null
      path = parsed.pathname
    } catch { return null }
    if (!adapter.allowed_path_prefixes.some((rawPrefix) => {
      const prefix = String(rawPrefix).replace(/\/+$/, '') || '/'
      return path === prefix || path.startsWith(`${prefix}/`)
    })) return null
  }
  const executable = {
    id: String(adapter.id),
    version: String(adapter.version),
    portal_host: adapterHost,
    reviewed_at: String(adapter.reviewed_at),
    fixture_contract_sha256: String(adapter.fixture_contract_sha256).toLowerCase(),
    mode: adapter.mode,
    application_identity_kind: adapter.application_identity_kind,
    allowed_path_prefixes: Object.freeze(adapter.allowed_path_prefixes.map(String)),
    auth_path_prefixes: Object.freeze(adapter.auth_path_prefixes.map(String)),
    allowed_origins: Object.freeze(adapter.allowed_origins.map(String)),
    submit_control: Object.freeze({
      selector: String(adapter.submit_control.selector),
      exact_text_sha256: String(adapter.submit_control.exact_text_sha256).toLowerCase(),
    }),
    field_contract: Object.freeze({
      version: 'exact-fields-v1',
      fields: Object.freeze(adapter.field_contract.fields.map((field) => Object.freeze({
        path_prefix: String(field.path_prefix),
        selector: String(field.selector),
        answer_key: String(field.answer_key),
        control_type: String(field.control_type),
        transform: String(field.transform),
        required: field.required === true,
      }))),
    }),
    receipt: Object.freeze({
      exact_labels: Object.freeze((adapter.receipt?.exact_labels || []).map(String)),
      container_selector: String(adapter.receipt.container_selector),
      identity_selector: String(adapter.receipt.identity_selector),
      identity_attribute: String(adapter.receipt.identity_attribute),
    }),
    reconciliation_mode: adapter.reconciliation_mode === 'authenticated_exact_application_lookup_v1'
      ? adapter.reconciliation_mode
      : null,
    status_query: Object.freeze({
      mode: String(adapter.status_query?.mode || ''),
      query_parameter: String(adapter.status_query?.query_parameter || ''),
      path_prefix: String(adapter.status_query?.path_prefix || ''),
      container_selector: String(adapter.status_query?.container_selector || ''),
      status_selector: String(adapter.status_query?.status_selector || ''),
      identity_selector: String(adapter.status_query?.identity_selector || ''),
      identity_attribute: String(adapter.status_query?.identity_attribute || ''),
      received_states: Object.freeze((adapter.status_query?.received_states || []).map(String)),
      absent_states: Object.freeze((adapter.status_query?.absent_states || []).map(String)),
    }),
    operator_validation_version: adapter.operator_validation_version,
    synthetic_fixture_only: syntheticFixtureOnly,
    operator_validation_artifact_id: adapter.operator_validation_artifact_id || null,
    operator_validation_evidence_sha256: adapter.operator_validation_evidence_sha256 || null,
    operator_validation_environment: adapter.operator_validation_environment || null,
    operator_validation_expires_at: adapter.operator_validation_expires_at || null,
  }
  return Object.freeze(executable)
}

function adapterHostEndsInvalid(adapter) {
  const host = normalizeHost(adapter?.portal_host)
  return Boolean(host && host.endsWith('.invalid'))
}

/**
 * Upsert a policy row. Used by admins (and the resolver when it
 * detects "automation forbidden" text on a portal it has not seen
 * before) to record what we observed.
 */
export async function upsertPolicy(db, {
  portalHost,
  automationAllowed = true,
  agentSubmissionAllowed = true,
  scrapingAllowed = false,
  apiAvailable = false,
  manualOnly = false,
  fallbackPath = null,
  sourceOfPolicy = null,
  notes = null,
  metadata = {},
} = {}) {
  if (!db) throw new Error('db required')
  const host = normalizeHost(portalHost)
  if (!host) throw new Error('portalHost required')
  await ensureSchema(db)
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  const existing = await db.prepare('SELECT id FROM hamilton_portal_policies WHERE portal_host = ? LIMIT 1').get(host)
  if (existing) {
    await db.prepare(
      `UPDATE hamilton_portal_policies SET
          automation_allowed = ?, agent_submission_allowed = ?, scraping_allowed = ?,
          api_available = ?, manual_only = ?, fallback_path = ?, source_of_policy = ?,
          notes = ?, last_checked_at = ${nowFn}, metadata_json = ?, updated_at = ${nowFn}
        WHERE id = ?`,
    ).run(
      automationAllowed ? 1 : 0, agentSubmissionAllowed ? 1 : 0, scrapingAllowed ? 1 : 0,
      apiAvailable ? 1 : 0, manualOnly ? 1 : 0, fallbackPath, sourceOfPolicy,
      notes, JSON.stringify(metadata || {}), existing.id,
    )
  } else {
    await db.prepare(
      `INSERT INTO hamilton_portal_policies
          (id, portal_host, automation_allowed, agent_submission_allowed, scraping_allowed,
           api_available, manual_only, fallback_path, source_of_policy, notes,
           last_checked_at, metadata_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${nowFn}, ?, ${nowFn}, ${nowFn})`,
    ).run(
      crypto.randomUUID(), host,
      automationAllowed ? 1 : 0, agentSubmissionAllowed ? 1 : 0, scrapingAllowed ? 1 : 0,
      apiAvailable ? 1 : 0, manualOnly ? 1 : 0, fallbackPath, sourceOfPolicy, notes,
      JSON.stringify(metadata || {}),
    )
  }
  return await getPolicyFor(db, host)
}

/**
 * Record that a portal blocked our SERVER-side browser with a stable anti-bot /
 * IP-reputation wall — the kind the engine upgrade (#992) can't defeat because
 * it's scored on our datacenter egress IP, not the browser fingerprint. This is
 * how Hamilton "learns the wall once": the first observation is persisted, and
 * getPortalWallStatus() then diverts every later attempt away from the doomed
 * server browser BEFORE it launches.
 *
 * ONLY call this for a genuinely stable signal (classifyBlocker →
 * `portal_anti_bot_block`). A transient failure (`portal_unreachable`: timeout,
 * DNS, 5xx) must NOT be recorded — the site may simply be down, and learning a
 * wall from it would wrongly retire a working portal.
 *
 * Merges into metadata_json.datacenter_block without disturbing the row's
 * automation/policy fields. Idempotent-ish: repeat observations bump `hits` and
 * `last_seen_at` and re-arm a previously-cleared block.
 *
 * @returns {Promise<object>} the updated datacenter_block record.
 */
export async function recordPortalWallObservation(db, { portalHost, category = 'portal_anti_bot_block', signal = null, engine = null } = {}) {
  if (!db) throw new Error('db required')
  const host = normalizeHost(portalHost)
  if (!host) throw new Error('portalHost required')
  await ensureSchema(db)
  const nowIso = new Date().toISOString()
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'

  const existing = await db.prepare('SELECT * FROM hamilton_portal_policies WHERE portal_host = ? LIMIT 1').get(host)
  const metadata = existing ? parseMetadata(existing.metadata_json) : {}
  const prior = metadata.datacenter_block && !metadata.datacenter_block.cleared_at ? metadata.datacenter_block : null
  const block = {
    // A stable anti-bot signal is trustworthy on the FIRST sighting, so we
    // confirm immediately — the owner's rule is "only hit the wall once", and a
    // two-strike scheme would hit it twice. The TTL re-probe is the safety valve.
    state: 'confirmed',
    category,
    signal: signal || prior?.signal || null,
    engine: engine || prior?.engine || null,
    first_seen_at: prior?.first_seen_at || nowIso,
    last_seen_at: nowIso,
    hits: (prior?.hits || 0) + 1,
    cleared_at: null,
  }
  metadata.datacenter_block = block

  if (existing) {
    await db.prepare(
      `UPDATE hamilton_portal_policies SET metadata_json = ?, last_checked_at = ${nowFn}, updated_at = ${nowFn} WHERE portal_host = ?`,
    ).run(JSON.stringify(metadata), host)
  } else {
    // No row yet — persist the seed/default policy for this host so its
    // automation flags survive, with the learned wall attached.
    const base = await getPolicyFor(db, host)
    await db.prepare(
      `INSERT INTO hamilton_portal_policies
          (id, portal_host, automation_allowed, agent_submission_allowed, scraping_allowed,
           api_available, manual_only, fallback_path, source_of_policy, notes,
           last_checked_at, metadata_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${nowFn}, ?, ${nowFn}, ${nowFn})`,
    ).run(
      crypto.randomUUID(), host,
      base.automation_allowed ? 1 : 0, base.agent_submission_allowed ? 1 : 0, base.scraping_allowed ? 1 : 0,
      base.api_available ? 1 : 0, base.manual_only ? 1 : 0, base.fallback_path, base.source_of_policy, base.notes,
      JSON.stringify(metadata),
    )
  }
  return block
}

/**
 * Should Hamilton SKIP the server-side browser for this portal because a wall
 * has already been learned? Consulted BEFORE launch so a known-blocked portal
 * never wastes a launch+navigation just to hit the same wall again.
 *
 * A confirmed block older than WALL_REPROBE_MS returns `blocked:false` with
 * `dueForReprobe:true` — the caller tries the real browser once more, and either
 * re-records the wall (still blocked) or, if it renders now, the block can be
 * cleared. This keeps a lifted wall from permanently retiring a portal.
 *
 * @returns {Promise<{blocked:boolean, dueForReprobe:boolean, block:object|null}>}
 */
export async function getPortalWallStatus(db, portalHost) {
  const host = normalizeHost(portalHost)
  if (!host || !db) return { blocked: false, dueForReprobe: false, block: null }
  const policy = await getPolicyFor(db, host)
  const block = policy?.datacenter_block
  if (!block || block.cleared_at || block.state !== 'confirmed') {
    return { blocked: false, dueForReprobe: false, block: block || null }
  }
  const lastSeen = Date.parse(block.last_seen_at || block.first_seen_at || '')
  const stale = Number.isFinite(lastSeen) && (Date.now() - lastSeen) > WALL_REPROBE_MS
  if (stale) return { blocked: false, dueForReprobe: true, block }
  return { blocked: true, dueForReprobe: false, block }
}

/**
 * Clear a learned wall (admin action, or after a successful real-browser render
 * proves the block has lifted). Leaves an audit trail: the block object is kept
 * with `cleared_at` set rather than deleted, and state flips to 'cleared'.
 */
export async function clearPortalWall(db, portalHost) {
  if (!db) throw new Error('db required')
  const host = normalizeHost(portalHost)
  if (!host) throw new Error('portalHost required')
  await ensureSchema(db)
  const existing = await db.prepare('SELECT * FROM hamilton_portal_policies WHERE portal_host = ? LIMIT 1').get(host)
  if (!existing) return { cleared: false, reason: 'no_row' }
  const metadata = parseMetadata(existing.metadata_json)
  if (!metadata.datacenter_block) return { cleared: false, reason: 'no_block' }
  metadata.datacenter_block = { ...metadata.datacenter_block, state: 'cleared', cleared_at: new Date().toISOString() }
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  await db.prepare(
    `UPDATE hamilton_portal_policies SET metadata_json = ?, updated_at = ${nowFn} WHERE portal_host = ?`,
  ).run(JSON.stringify(metadata), host)
  return { cleared: true }
}

export async function listPolicies(db) {
  const decorateSeed = (policy) => ({ ...policy, submission_adapter: null, submission_mode: 'draft_only' })
  if (!db) return SEED_POLICIES.map(decorateSeed)
  await ensureSchema(db)
  const rows = await db.prepare('SELECT * FROM hamilton_portal_policies ORDER BY portal_host').all()
  const overrides = new Map((rows || []).map((r) => [r.portal_host, rowToPolicy(r)]))
  const merged = SEED_POLICIES.map((seed) => overrides.get(seed.portal_host) || decorateSeed(seed))
  return merged.concat([...overrides.values()].filter((o) => !SEED_POLICIES.find((s) => s.portal_host === o.portal_host)))
}

export const SEED_PORTAL_POLICIES = SEED_POLICIES
