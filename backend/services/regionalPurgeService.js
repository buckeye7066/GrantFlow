/**
 * regionalPurgeService.js
 *
 * Core orchestration for the regional purge system.
 *
 * Responsibilities:
 *  1. Discover target states from active profiles (dynamic, not hardcoded).
 *  2. Select active funding opportunities for those states.
 *  3. Re-check each opportunity's source URL.
 *  4. Determine whether a material change occurred (purgeMaterialChange).
 *  5. Verify the change via primary sources (purgeVerification).
 *  6. Transition suppression_state:
 *       suppressed – material + verified
 *       watch      – material but unverified (ambiguous)
 *       active     – no material change (or verified still active)
 *  7. Persist the new state + emit a durable event row.
 *  8. Support dry-run mode (no DB writes).
 *  9. Restore suppressed items that verify as live again.
 *
 * Safe to re-run (idempotent on unchanged opportunities).
 */

import { detectMaterialChange } from './purgeMaterialChange.js'
import { verifyOpportunityUrl } from './purgeVerification.js'
import { stableTextHash } from './purgeDiffUtils.js'
import { sanitizeLogValue } from '../utils/logger.js'
import { randomUUID } from 'crypto'
import { createLogger } from '../utils/logger.js'
const log = createLogger('regionalPurgeService')

// ─── Constants ────────────────────────────────────────────────────────────────

export const SUPPRESSION_STATES = {
  ACTIVE: 'active',
  WATCH: 'watch',
  SUPPRESSED: 'suppressed',
}

// Heuristic tier inference from source domain/type
const TIER_A_PATTERNS = [
  /grants\.gov/i,
  /grantsgov/i,
  /sam\.gov/i,
  /usaspending\.gov/i,
  /cfda\.gov/i,
  /grantsolutions\.gov/i,
  /grants\.ohio\.gov/i,
  /tn\.gov/i,
  /state\.[a-z]{2}\.us/i,
  /\.gov(\/|$)/i,
]

/**
 * Infer source tier from URL / source string.
 * @returns {'tier_a'|'tier_b'|'unknown'}
 */
export function inferSourceTier(sourceUrl) {
  if (!sourceUrl) return 'unknown'
  if (TIER_A_PATTERNS.some((p) => p.test(String(sourceUrl)))) return 'tier_a'
  return 'tier_b'
}

// ─── State discovery ──────────────────────────────────────────────────────────

/**
 * Derive the list of distinct 2-letter uppercase US state codes
 * from active profiles in the database.
 *
 * Sources checked (in order):
 *  1. profiles.state column
 *  2. profile_sections.basic_information data.state / data.zip
 *  3. organizations.state linked to the profile
 *
 * @param {object} db  - DB wrapper (better-sqlite3 or pg-compatible)
 * @returns {string[]} - deduped, sorted array of uppercase 2-letter state codes
 */
export function discoverActiveProfileStates(db) {
  const states = new Set()

  // 1. Direct profiles.state column
  try {
    const rows = db.prepare(`
      SELECT DISTINCT state
      FROM profiles
      WHERE state IS NOT NULL AND state != ''
    `).all()
    for (const r of rows) addState(states, r.state)
  } catch {
    // table may not exist in test environments
  }

  // 2. profile_sections basic_information
  try {
    const rows = db.prepare(`
      SELECT data
      FROM profile_sections
      WHERE section_key = 'basic_information'
        AND data IS NOT NULL AND data != ''
    `).all()
    for (const r of rows) {
      try {
        const d = JSON.parse(r.data)
        if (d?.state) addState(states, d.state)
        if (d?.zip) {
          const st = stateFromZip(d.zip)
          if (st) states.add(st)
        }
      } catch { /* malformed JSON */ }
    }
  } catch {
    // table may not exist
  }

  // 3. Organizations linked to profiles
  try {
    const rows = db.prepare(`
      SELECT DISTINCT o.state
      FROM organizations o
      JOIN profiles p ON p.organization_id = o.id
      WHERE o.state IS NOT NULL AND o.state != ''
    `).all()
    for (const r of rows) addState(states, r.state)
  } catch {
    // organizations or join may not be available
  }

  return [...states].sort()
}

function addState(set, raw) {
  if (!raw) return
  const s = String(raw).trim().toUpperCase()
  if (s.length === 2 && /^[A-Z]{2}$/.test(s)) set.add(s)
}

// Very minimal ZIP → state map for common states (augmented heuristic only)
const ZIP_STATE_RANGES = [
  [[35004, 36925], 'AL'],
  [[99501, 99950], 'AK'],
  [[85001, 86556], 'AZ'],
  [[71601, 72959], 'AR'],
  [[90001, 96162], 'CA'],
  [[80001, 81658], 'CO'],
  [[6001, 6928], 'CT'],
  [[19701, 19980], 'DE'],
  [[32004, 34997], 'FL'],
  [[30001, 31999], 'GA'],
  [[96701, 96898], 'HI'],
  [[83201, 83876], 'ID'],
  [[60001, 62999], 'IL'],
  [[46001, 47997], 'IN'],
  [[50001, 52809], 'IA'],
  [[66002, 67954], 'KS'],
  [[40003, 42788], 'KY'],
  [[70001, 71497], 'LA'],
  [[3901, 4992], 'ME'],
  [[20601, 21930], 'MD'],
  [[1001, 2791], 'MA'],
  [[48001, 49971], 'MI'],
  [[55001, 56763], 'MN'],
  [[38601, 39776], 'MS'],
  [[63001, 65899], 'MO'],
  [[59001, 59937], 'MT'],
  [[68001, 69367], 'NE'],
  [[88901, 89883], 'NV'],
  [[3031, 3897], 'NH'],
  [[7001, 8989], 'NJ'],
  [[87001, 88441], 'NM'],
  [[10001, 14975], 'NY'],
  [[27006, 28909], 'NC'],
  [[58001, 58856], 'ND'],
  [[43001, 45999], 'OH'],
  [[73001, 74966], 'OK'],
  [[97001, 97920], 'OR'],
  [[15001, 19640], 'PA'],
  [[2801, 2940], 'RI'],
  [[29001, 29948], 'SC'],
  [[57001, 57799], 'SD'],
  [[37010, 38589], 'TN'],
  [[75001, 79999], 'TX'],
  [[84001, 84784], 'UT'],
  [[5001, 5907], 'VT'],
  [[20101, 24658], 'VA'],
  [[98001, 99403], 'WA'],
  [[24701, 26886], 'WV'],
  [[53001, 54990], 'WI'],
  [[82001, 83128], 'WY'],
]

function stateFromZip(zip) {
  const n = parseInt(String(zip).replace(/\D/g, ''), 10)
  if (isNaN(n)) return null
  for (const [[lo, hi], st] of ZIP_STATE_RANGES) {
    if (n >= lo && n <= hi) return st
  }
  return null
}

// ─── Main orchestration ───────────────────────────────────────────────────────

/**
 * Run the regional purge for all relevant states.
 *
 * @param {object} db
 * @param {object} [options]
 * @param {boolean}  [options.dryRun=false]   - if true, no DB mutations
 * @param {string[]} [options.states]          - explicit state list; auto-discovered if omitted
 * @param {number}   [options.limit=500]       - max opportunities per run
 * @param {boolean}  [options.onlySuppressedCandidates=false] - restrict to watch/suppressed only
 * @param {Function} [options.fetchFn]         - injectable HTTP fetch (for tests)
 *
 * @returns {Promise<{
 *   statesProcessed: string[],
 *   checked: number,
 *   active: number,
 *   watch: number,
 *   suppressed: number,
 *   errors: number,
 *   perState: Object,
 * }>}
 */
export async function runRegionalPurge(db, options = {}) {
  const {
    dryRun = false,
    states: explicitStates,
    limit = 500,
    onlySuppressedCandidates = false,
    fetchFn,
  } = options

  const targetStates = explicitStates?.length
    ? explicitStates.map((s) => String(s).trim().toUpperCase())
    : discoverActiveProfileStates(db)

  const summary = {
    statesProcessed: targetStates,
    checked: 0,
    active: 0,
    watch: 0,
    suppressed: 0,
    errors: 0,
    perState: {},
  }

  if (targetStates.length === 0) {
    return summary
  }

  // Build placeholder list for IN clause
  const isPg = db?.dialect === 'postgres'
  const activeVal = isPg ? true : 1

  // Use parameterized IN clause placeholders
  const statePlaceholders = targetStates.map(() => '?').join(', ')
  const stateFilter = `state IN (${statePlaceholders})`
  const candidateFilter = onlySuppressedCandidates
    ? `(suppression_state = 'watch' OR suppression_state = 'suppressed')`
    : `(suppression_state IS NULL OR suppression_state = 'active' OR suppression_state = 'watch' OR suppression_state = 'suppressed')`

  let opportunities
  try {
    opportunities = db.prepare(`
      SELECT id, title, source_url, description, status, deadline,
             suppression_state, last_seen_hash, last_seen_text,
             last_status, last_deadline, source_tier, state
      FROM funding_opportunities
      WHERE is_active = ?
        AND ${stateFilter}
        AND ${candidateFilter}
      LIMIT ?
    `).all(activeVal, ...targetStates, limit)
  } catch (err) {
    log.error('[regionalPurge] Failed to query opportunities:', err?.message)
    summary.errors++
    return summary
  }

  // Ensure the suppression event table exists
  ensureSuppressionEventsTable(db)

  if (opportunities.length === 0) {
    // CodeQL js/log-injection (#614): targetStates is req.body.states on an
    // admin-only route, with no per-element format check before logging.
    console.warn(
      `[regionalPurge] No candidate opportunities returned for states: ${sanitizeLogValue(targetStates.join(', '))}. ` +
      `candidateFilter=${candidateFilter.replace(/\s+/g, ' ')} onlySuppressedCandidates=${onlySuppressedCandidates}`
    )
  }

  for (const opp of opportunities) {
    const state = opp.state || 'UNKNOWN'
    if (!summary.perState[state]) {
      summary.perState[state] = { checked: 0, active: 0, watch: 0, suppressed: 0, errors: 0 }
    }
    summary.checked++
    summary.perState[state].checked++

    try {
      const outcome = await processOneOpportunity(db, opp, { dryRun, fetchFn })
      summary[outcome]++
      summary.perState[state][outcome]++
    } catch (err) {
      log.error(`[regionalPurge] Error processing ${opp.id}:`, err?.message)
      summary.errors++
      summary.perState[state].errors++
    }
  }

  return summary
}

// ─── Per-opportunity processing ───────────────────────────────────────────────

async function processOneOpportunity(db, opp, { dryRun, fetchFn }) {
  const sourceUrl = opp.source_url
  const currentText = opp.description || ''
  const previousText = opp.last_seen_text || ''
  const previousHash = opp.last_seen_hash || ''
  const currentHash = stableTextHash(currentText)

  // Determine effective tier
  const tier = opp.source_tier && opp.source_tier !== 'unknown'
    ? opp.source_tier
    : inferSourceTier(sourceUrl)

  // ── Step 1: detect material change ──────────────────────────────────────
  const changeResult = detectMaterialChange(
    {
      status: opp.last_status,
      deadline: opp.last_deadline,
      text: previousText,
    },
    {
      status: opp.status,
      deadline: opp.deadline,
      text: currentText,
    },
  )

  // ── Step 2: verify change via primary source ─────────────────────────────
  let verificationResult = { verified: false, signals: [], verificationLevel: 'none', statusHint: 'unknown' }
  if (!sourceUrl) {
    // GOAL 1/3: No application URL â treat as suppression candidate immediately.
    // Store a specific reason so the audit trail is clear (Goal 8).
    verificationResult = {
      verified: true,
      signals: ['no_source_url'],
      verificationLevel: 'primary',
      statusHint: 'closed',
    }
  } else if (changeResult.changed) {
    verificationResult = await verifyOpportunityUrl(sourceUrl, { fetchFn })
  } else {
    // Lightweight check even when no material change detected.
    try {
      verificationResult = await verifyOpportunityUrl(sourceUrl, { fetchFn })
    } catch { /* non-fatal */ }
  }

  // ── Step 3: determine next suppression state ─────────────────────────────
  let nextState = SUPPRESSION_STATES.ACTIVE
  let reason = null

  const isMaterialAndVerified = changeResult.changed && verificationResult.verified
  const isVerifiedActive = verificationResult.statusHint === 'active'
  const isVerifiedClosed = verificationResult.statusHint === 'closed'

  // GOAL 3/4/7: Only hard-suppress on primary-source CLOSED signal.
  // Material-change-only (text diff) must NOT immediately suppress; use WATCH
  // so the next purge cycle can re-verify before removing from the pipeline.
  if (isVerifiedClosed && verificationResult.verificationLevel === 'primary') {
    nextState = SUPPRESSION_STATES.SUPPRESSED
    reason = changeResult.reason || 'http_410'
  } else if (isMaterialAndVerified && isVerifiedClosed) {
    // Both a material change AND an explicit closed signal are required for suppression.
    nextState = SUPPRESSION_STATES.SUPPRESSED
    reason = changeResult.reason || 'text_diff_verified_closed'
  } else if (isMaterialAndVerified && !isVerifiedClosed) {
    // Material change detected but source does NOT confirm closed â hold at WATCH.
    nextState = SUPPRESSION_STATES.WATCH
    reason = 'material_change_unconfirmed_closed'
  } else if (changeResult.changed && !verificationResult.verified) {
    // Material change but unverified — mark as watch
    nextState = SUPPRESSION_STATES.WATCH
    reason = 'verification_missing'
  } else if (isVerifiedActive) {
    // Previously suppressed/watch but now verified active → restore
    if (opp.suppression_state === SUPPRESSION_STATES.SUPPRESSED ||
        opp.suppression_state === SUPPRESSION_STATES.WATCH) {
      nextState = SUPPRESSION_STATES.ACTIVE
      reason = 'restored_active'
    } else {
      nextState = SUPPRESSION_STATES.ACTIVE
    }
  } else {
    nextState = opp.suppression_state || SUPPRESSION_STATES.ACTIVE
  }

  const previousState = opp.suppression_state || SUPPRESSION_STATES.ACTIVE

  // ── Step 4: persist ────────────────────────────────────────────────────
  if (dryRun) {
    // GOAL 8: Always log the computed outcome in dry-run so operators can audit
    // what would have changed without DB writes.
    log.info(
      `[regionalPurge][dryRun] opp=${opp.id} prev=${previousState} next=${nextState}` +
      ` reason=${reason ?? 'none'} statusHint=${verificationResult.statusHint}` +
      ` similarity=${changeResult.similarity?.toFixed(3) ?? 'n/a'}`
    )
  } else if (nextState !== previousState) {
    persistSuppressionTransition(db, {
      opportunity: opp,
      previousState,
      nextState,
      reason,
      changeResult,
      verificationResult,
      currentHash,
      currentText,
    })
  } else {
    // State unchanged â update heartbeat columns only.
    updateLastChecked(db, opp, currentHash, currentText)
  }

  return nextState
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

function persistSuppressionTransition(db, {
  opportunity, previousState, nextState, reason,
  changeResult, verificationResult, currentHash, currentText,
}) {
  const now = new Date().toISOString()
  const isPg = db?.dialect === 'postgres'

  // Determine is_active for the opportunity
  // GOAL 7/13: Do NOT flip is_active=0 at suppression time.
  // The opportunity remains queryable so existing pipeline rows and
  // audit queries still resolve. Consumers filter on suppression_state instead.
  // Only hard-delete or deactivation workflows should touch is_active.
  const isActive = isPg ? true : 1

  const transaction = db.transaction(() => {
    db.prepare(`
      UPDATE funding_opportunities
      SET suppression_state    = ?,
          suppression_reason   = ?,
          suppression_metadata = ?,
          last_seen_hash       = ?,
          last_seen_text       = ?,
          last_checked_at      = ?,
          last_status          = ?,
          last_deadline        = ?,
          source_tier          = ?,
          is_active            = ?,
          updated_at           = ?
      WHERE id = ?
    `).run(
      nextState,
      reason,
      JSON.stringify({
        similarity: changeResult.similarity,
        tokenDiffRatio: changeResult.tokenDiffRatio,
        fieldChanges: changeResult.fieldChanges,
        verificationLevel: verificationResult.verificationLevel,
        statusHint: verificationResult.statusHint,
      }),
      currentHash,
      currentText?.slice(0, 20000) || null, // cap stored text size
      now,
      opportunity.status || null,
      opportunity.deadline || null,
      inferSourceTier(opportunity.source_url),
      isActive,
      now,
      opportunity.id,
    )

    const eventId = randomUUID()
    db.prepare(`
      INSERT INTO opportunity_suppression_events
        (id, opportunity_id, previous_state, new_state, reason,
         similarity, token_diff_ratio, verification_signals,
         source_url, checked_at, actor, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'regional_purge', ?)
    `).run(
      eventId,
      opportunity.id,
      previousState,
      nextState,
      reason,
      changeResult.similarity,
      changeResult.tokenDiffRatio,
      JSON.stringify(verificationResult.signals),
      opportunity.source_url || null,
      now,
      JSON.stringify({ statusHint: verificationResult.statusHint }),
    )
  })

  try {
    transaction()
  } catch (err) {
    log.error('[regionalPurge] Failed to persist suppression transition:', err?.message)
    throw err
  }
}

function updateLastChecked(db, opportunity, currentHash, currentText) {
  const now = new Date().toISOString()
  try {
    db.prepare(`
      UPDATE funding_opportunities
      SET last_checked_at = ?,
          last_seen_hash  = ?,
          last_seen_text  = ?,
          last_status     = ?,
          last_deadline   = ?,
          source_tier     = ?
      WHERE id = ?
    `).run(
      now,
      currentHash,
      currentText?.slice(0, 20000) || null,
      opportunity.status || null,
      opportunity.deadline || null,
      opportunity.source_tier || inferSourceTier(opportunity.source_url),
      opportunity.id,
    )
  } catch { /* non-fatal */ }
}

/**
 * Ensure the suppression events table and new columns exist.
 * This is the "app-level" migration for environments that don't run
 * the SQL migration runner (e.g. test in-memory DBs).
 */
export function ensureSuppressionSchema(db) {
  // New table
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS opportunity_suppression_events (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        opportunity_id TEXT NOT NULL,
        previous_state TEXT NOT NULL DEFAULT 'active',
        new_state TEXT NOT NULL,
        reason TEXT,
        similarity REAL,
        token_diff_ratio REAL,
        verification_signals TEXT,
        source_url TEXT,
        checked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        actor TEXT DEFAULT 'regional_purge',
        notes TEXT
      )
    `)
  } catch { /* already exists */ }

  // Indexes
  for (const ddl of [
    `CREATE INDEX IF NOT EXISTS idx_suppression_events_opp ON opportunity_suppression_events(opportunity_id)`,
    `CREATE INDEX IF NOT EXISTS idx_suppression_events_checked ON opportunity_suppression_events(checked_at)`,
    `CREATE INDEX IF NOT EXISTS idx_suppression_events_state ON opportunity_suppression_events(new_state)`,
  ]) {
    try { db.exec(ddl) } catch { /* ignore */ }
  }

  // Columns on funding_opportunities
  const newCols = [
    `ALTER TABLE funding_opportunities ADD COLUMN last_seen_text TEXT`,
    `ALTER TABLE funding_opportunities ADD COLUMN last_seen_hash TEXT`,
    `ALTER TABLE funding_opportunities ADD COLUMN last_checked_at DATETIME`,
    `ALTER TABLE funding_opportunities ADD COLUMN suppression_state TEXT DEFAULT 'active'`,
    `ALTER TABLE funding_opportunities ADD COLUMN suppression_reason TEXT`,
    `ALTER TABLE funding_opportunities ADD COLUMN suppression_metadata TEXT`,
    `ALTER TABLE funding_opportunities ADD COLUMN last_status TEXT`,
    `ALTER TABLE funding_opportunities ADD COLUMN last_deadline DATE`,
    `ALTER TABLE funding_opportunities ADD COLUMN source_tier TEXT DEFAULT 'unknown'`,
  ]
  for (const ddl of newCols) {
    try { db.prepare(ddl).run() } catch { /* column already exists */ }
  }
}

function ensureSuppressionEventsTable(db) {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS opportunity_suppression_events (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        opportunity_id TEXT NOT NULL,
        previous_state TEXT NOT NULL DEFAULT 'active',
        new_state TEXT NOT NULL,
        reason TEXT,
        similarity REAL,
        token_diff_ratio REAL,
        verification_signals TEXT,
        source_url TEXT,
        checked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        actor TEXT DEFAULT 'regional_purge',
        notes TEXT
      )
    `)
  } catch { /* already exists */ }
}

/**
 * Get a summary of recent purge events from the DB.
 */
export function getPurgeSummary(db) {
  try {
    ensureSuppressionEventsTable(db)
    const totals = db.prepare(`
      SELECT new_state, COUNT(*) AS cnt
      FROM opportunity_suppression_events
      GROUP BY new_state
    `).all()

    const recent = db.prepare(`
      SELECT e.*, o.state as opp_state, o.title
      FROM opportunity_suppression_events e
      LEFT JOIN funding_opportunities o ON o.id = e.opportunity_id
      ORDER BY e.checked_at DESC
      LIMIT 20
    `).all()

    return { totals, recent }
  } catch (err) {
    return { totals: [], recent: [], error: err?.message }
  }
}

/**
 * Get paginated suppression events.
 */
export function getPurgeEvents(db, { page = 1, pageSize = 50, state } = {}) {
  try {
    ensureSuppressionEventsTable(db)
    const offset = (Math.max(1, page) - 1) * pageSize

    // Validate state is a clean 2-letter code before using it
    const validState = state && /^[A-Z]{2}$/.test(String(state).toUpperCase())
      ? String(state).toUpperCase()
      : null

    if (validState) {
      const rows = db.prepare(`
        SELECT e.*, o.state as opp_state, o.title
        FROM opportunity_suppression_events e
        LEFT JOIN funding_opportunities o ON o.id = e.opportunity_id
        WHERE o.state = ?
        ORDER BY e.checked_at DESC
        LIMIT ? OFFSET ?
      `).all(validState, pageSize, offset)

      const countRow = db.prepare(`
        SELECT COUNT(*) AS total
        FROM opportunity_suppression_events e
        LEFT JOIN funding_opportunities o ON o.id = e.opportunity_id
        WHERE o.state = ?
      `).get(validState)

      return { rows, total: Number(countRow?.total ?? 0), page, pageSize }
    }

    const rows = db.prepare(`
      SELECT e.*, o.state as opp_state, o.title
      FROM opportunity_suppression_events e
      LEFT JOIN funding_opportunities o ON o.id = e.opportunity_id
      ORDER BY e.checked_at DESC
      LIMIT ? OFFSET ?
    `).all(pageSize, offset)

    const countRow = db.prepare(`
      SELECT COUNT(*) AS total
      FROM opportunity_suppression_events e
    `).get()

    return { rows, total: Number(countRow?.total ?? 0), page, pageSize }
  } catch (err) {
    return { rows: [], total: 0, page, pageSize, error: err?.message }
  }
}
