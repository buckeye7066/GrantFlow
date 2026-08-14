/**
 * pipelineGoalCleanupService.js
 *
 * Mission-goal-aligned audit + cleanup of every profile's pipeline (the
 * `grants` table). The service walks every grant for every profile and
 * decides — using the canonical building blocks (PIPELINE_ALLOWED_SOURCES,
 * applyRelevanceFilter, computeMatchDecision) — whether the item belongs.
 *
 * Per-item verdicts (in evaluation order; first match wins):
 *
 *   1. source_disallowed  — linked opportunity's `source` is not on the
 *                           canonical allowlist (PIPELINE_ALLOWED_SOURCES).
 *                           Goal 1: Real funding only.
 *
 *   2. dead_url           — no usable application URL on the grant or the
 *                           linked opportunity, AND the opportunity is not
 *                           a directory-style resource. Goal 1 (no dead
 *                           links) + Goal 7 (clear discovery — user must
 *                           be able to act on the item).
 *
 *   3. duplicate_title    — same title already seen earlier in this
 *                           profile's pipeline. Keeps the first occurrence,
 *                           removes the rest. Goal 9: explainable.
 *
 *   4. wrong_state        — title clearly mentions a state that is not the
 *                           profile's state (e.g. "Ohio Family and
 *                           Children First" on a TN profile). Goal 6:
 *                           geographic matching expands outward, not into
 *                           wrong states.
 *
 *   5. relevance_reject   — canonical match engine returns REJECT for the
 *                           (profile, opportunity) pair. Goal 2: match
 *                           actual needs (and Goal 4: support all user
 *                           types — eligibility-by-entity-type rules
 *                           live in matchEngine). Manual entries (no
 *                           linked opportunity) skip this check —
 *                           manual_entry items are kept on the basis that
 *                           the user explicitly added them.
 *
 *   6. keep               — passes every check.
 *
 * Important guarantees (from the project rules):
 *   - Directory-style resources ALWAYS pass dead_url and relevance_reject.
 *     They are referral funnels and must survive filtering unless
 *     explicitly excluded (Goal 8: avoid zero results, recall over
 *     suppression).
 *   - Soft mismatches NEVER trigger a removal. Only hard, explainable
 *     reasons remove items.
 *   - Missing/null profile fields default to neutral (do not eliminate).
 *
 * Returns a structured per-profile report so the user can see exactly why
 * each item was kept or removed (Goal 9: explainable + Goal 10: traceable
 * from discovery to action).
 */

import { PIPELINE_ALLOWED_SOURCES_SET } from '../config/pipelineAllowedSources.js'
import { applyRelevanceFilter } from './relevanceFilter.js'
import { computeMatchDecision } from './matchEngine.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('pipelineGoalCleanup')

const STATE_ABBRS = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY','DC',
])

function extractStateAbbrFromTitle(title) {
  const m = (title || '').match(/near\s+[\w\s]+,\s*([A-Z]{2})\b/)
  return m && STATE_ABBRS.has(m[1]) ? m[1] : null
}

const STATE_NAME_TO_ABBR = [
  ['west virginia', 'WV'], ['north carolina', 'NC'], ['north dakota', 'ND'],
  ['south carolina', 'SC'], ['south dakota', 'SD'], ['new hampshire', 'NH'],
  ['rhode island', 'RI'], ['new mexico', 'NM'], ['new jersey', 'NJ'],
  ['new york', 'NY'], ['connecticut', 'CT'], ['massachusetts', 'MA'],
  ['mississippi', 'MS'], ['pennsylvania', 'PA'], ['minnesota', 'MN'],
  ['tennessee', 'TN'], ['california', 'CA'], ['louisiana', 'LA'],
  ['wisconsin', 'WI'], ['kentucky', 'KY'], ['oklahoma', 'OK'],
  ['nebraska', 'NE'], ['arkansas', 'AR'], ['colorado', 'CO'],
  ['maryland', 'MD'], ['michigan', 'MI'], ['missouri', 'MO'],
  ['delaware', 'DE'], ['illinois', 'IL'], ['virginia', 'VA'],
  ['montana', 'MT'], ['wyoming', 'WY'], ['georgia', 'GA'],
  ['arizona', 'AZ'], ['indiana', 'IN'], ['florida', 'FL'],
  ['alabama', 'AL'], ['vermont', 'VT'], ['kansas', 'KS'],
  ['nevada', 'NV'], ['oregon', 'OR'], ['alaska', 'AK'],
  ['hawaii', 'HI'], ['idaho', 'ID'], ['maine', 'ME'],
  ['texas', 'TX'], ['utah', 'UT'], ['iowa', 'IA'], ['ohio', 'OH'],
  // FIXED: 'washington' was missing (a real omission, not deliberate --
  // see relevanceFilter.js's identical fix for the rationale).
  ['washington', 'WA'],
]

// A state NAME used as the name of a COUNTY/CITY/PARISH is a place inside
// some OTHER state, not a claim about this one ("Delaware County, OH",
// "Washington County, PA", "Indiana County, PA", "Ohio County, WV" are all
// real places a bare substring test resolved to DE/WA/IN/OH). Mirrors the
// fix already applied in relevanceFilterRules.js's _extractStateNameFromTitle
// -- this file forked from the same original bare-substring implementation.
const PLACE_QUALIFIER_AFTER_STATE_NAME =
  /^\s*(county|counties|parish|borough|municipio|city|township|village|town|district)\b/i

function extractStateNameFromTitle(title) {
  const raw = String(title || '')
  const lower = raw.toLowerCase()
  for (const [name, abbr] of STATE_NAME_TO_ABBR) {
    let from = 0
    for (;;) {
      const at = lower.indexOf(name, from)
      if (at === -1) break
      const before = at === 0 ? '' : lower[at - 1]
      const after = lower.slice(at + name.length)
      const boundedLeft = at === 0 || !/[a-z0-9]/.test(before)
      const boundedRight = after === '' || !/^[a-z0-9]/.test(after)
      if (boundedLeft && boundedRight && !PLACE_QUALIFIER_AFTER_STATE_NAME.test(after)) return abbr
      from = at + 1
    }
  }
  return null
}

function safeJson(value, fallback) {
  if (value === null || value === undefined) return fallback
  if (typeof value === 'object') return value
  try {
    const parsed = JSON.parse(String(value))
    return parsed ?? fallback
  } catch {
    return fallback
  }
}

function pickNonEmpty(...values) {
  for (const v of values) {
    if (v === null || v === undefined) continue
    const s = String(v).trim()
    if (s) return s
  }
  return ''
}

function isDirectoryGrant(grantRow) {
  const kind = String(grantRow.opp_kind || grantRow.opp_opportunity_kind || '').toUpperCase()
  if (kind === 'DIRECTORY') return true
  const source = String(grantRow.opp_source || '').toLowerCase()
  if (source.includes('directory')) return true
  const origin = String(grantRow.opp_record_origin || '').toLowerCase()
  if (origin.startsWith('directory')) return true
  return false
}

function deriveProfileState(profile, sections) {
  const basic = sections.basic_information || {}
  const locFocus = sections.location_focus || {}
  const comp = sections.comprehensive_application || {}
  const tryAddr = (addr) => {
    if (!addr) return null
    if (typeof addr === 'string') {
      const m = addr.match(/\b([A-Z]{2})\s*,?\s*\d{5}/)
      return m ? m[1] : null
    }
    if (typeof addr === 'object') return addr.state || null
    return null
  }
  return (
    profile?.state ||
    basic.state ||
    locFocus.state ||
    tryAddr(basic.address) ||
    tryAddr(comp.address) ||
    null
  )
}

/**
 * Classify a single pipeline row against the mission goals.
 *
 * Pure function — does not touch the database. Exported for unit testing
 * so the verdict matrix is fully covered without spinning up a DB.
 *
 * @param {object} grantRow            Joined row (grants + linked
 *                                     funding_opportunities columns prefixed
 *                                     opp_*).
 * @param {object} ctx
 * @param {object} ctx.profile         Profile row (id, primary_type, tags, …).
 * @param {object} ctx.sections        { section_key: parsedData }.
 * @param {Set<string>} ctx.seenTitles Mutated — pass the same Set across all
 *                                     items for the same profile so dedupe
 *                                     keeps the first occurrence.
 * @returns {{ verdict: string, reason?: string, ruleId?: string }}
 */
export function classifyPipelineItem(grantRow, ctx) {
  const profile = ctx.profile || {}
  const sections = ctx.sections || {}
  const seenTitles = ctx.seenTitles instanceof Set ? ctx.seenTitles : new Set()
  const allowedSources = ctx.allowedSources instanceof Set
    ? ctx.allowedSources
    : PIPELINE_ALLOWED_SOURCES_SET

  const title = String(grantRow.title || '').trim() || '(untitled)'
  const linkedToOpportunity = Boolean(grantRow.funding_opportunity_id)
  const isDirectory = isDirectoryGrant(grantRow)

  // 1. Source allowlist (Goal 1)
  if (linkedToOpportunity && grantRow.opp_source !== null && grantRow.opp_source !== undefined) {
    const src = String(grantRow.opp_source).trim()
    if (src && !allowedSources.has(src)) {
      return {
        verdict: 'source_disallowed',
        reason: `Source "${src}" is not on the pipeline allowlist`,
        ruleId: 'goal1.source_allowlist',
      }
    }
  }

  // 2. Dead URL (Goal 1, Goal 7)
  const anyUrl = pickNonEmpty(
    grantRow.application_url,
    grantRow.grant_url,
    grantRow.portal_url,
    grantRow.opp_application_url,
    grantRow.opp_apply_url,
    grantRow.opp_source_url,
    grantRow.opp_evidence_url,
    grantRow.opp_verified_url,
  )
  const hasUsableUrl = Boolean(anyUrl) || isDirectory
  if (!hasUsableUrl) {
    return {
      verdict: 'dead_url',
      reason: 'No application URL on the grant or its linked opportunity',
      ruleId: 'goal1.no_dead_links',
    }
  }

  // 3. Duplicate title within this profile (Goal 9)
  if (seenTitles.has(title)) {
    return {
      verdict: 'duplicate_title',
      reason: 'Duplicate of an earlier item in this profile\'s pipeline',
      ruleId: 'goal9.no_duplicates',
    }
  }
  seenTitles.add(title)

  // 4. Wrong state (Goal 6)
  const profileState = deriveProfileState(profile, sections)
  if (profileState) {
    const titleState = extractStateAbbrFromTitle(title) || extractStateNameFromTitle(title)
    if (titleState && titleState !== profileState && !isDirectory) {
      return {
        verdict: 'wrong_state',
        reason: `Title implies ${titleState}, but profile is in ${profileState}`,
        ruleId: 'goal6.geographic_match',
      }
    }
  }

  // 5. Canonical match engine REJECT (Goal 2 + Goal 4)
  // Skip when the opportunity is a directory (Goal 8 — recall over
  // suppression), or when the grant is a manual entry (no linked opp). For
  // manual entries we already covered the URL and source checks above; the
  // user explicitly added it, so we leave the decision in their hands.
  if (linkedToOpportunity && !isDirectory) {
    const rawOpp = {
      id: grantRow.funding_opportunity_id,
      title: grantRow.title,
      description: grantRow.opp_description ?? grantRow.notes ?? null,
      sponsor: grantRow.opp_sponsor ?? grantRow.funder ?? null,
      eligibility_bullets: grantRow.opp_eligibility_bullets ?? null,
      categories: grantRow.opp_categories ?? null,
      keywords: grantRow.opp_keywords ?? null,
      is_national: grantRow.opp_is_national ?? null,
      state: grantRow.opp_state ?? null,
      // Pass the discovered URL through so the canonical
      // applyRelevanceFilter / makeDecision URL guards don't
      // double-fail an item we've already URL-validated above.
      application_url: anyUrl || grantRow.opp_application_url || null,
      url: anyUrl || null,
      source_url: grantRow.opp_source_url ?? null,
      record_origin: grantRow.opp_record_origin ?? null,
      is_loan: grantRow.opp_is_loan ?? null,
      deadline: grantRow.opp_deadline ?? null,
      deadline_type: grantRow.opp_deadline_type ?? null,
      funding_type: grantRow.opp_funding_type ?? null,
      opportunity_type: grantRow.opp_opportunity_type ?? null,
      entity_types_allowed: grantRow.opp_entity_types_allowed ?? null,
      need_types_supported: grantRow.opp_need_types_supported ?? null,
    }

    let decision
    try {
      decision = computeMatchDecision(
        { id: profile.id, primary_type: profile.primary_type, tags: profile.tags },
        rawOpp,
        { profileSections: sections },
      )
    } catch (err) {
      // Defensive — never let a matcher hiccup remove a user's item.
      log.warn(`[classifyPipelineItem] matchEngine threw for grant ${grantRow.id}: ${err?.message}`)
      decision = null
    }

    if (decision && decision.decision === 'REJECT') {
      const reason = Array.isArray(decision.ineligibilityReasons) && decision.ineligibilityReasons.length > 0
        ? decision.ineligibilityReasons.join('; ')
        : (decision.explanation || 'Hard match-engine rejection')
      return {
        verdict: 'relevance_reject',
        reason,
        ruleId: 'goal2.match_engine_reject',
      }
    }

    // Belt-and-suspenders: also run the canonical relevanceFilter in soft
    // mode so any rule explicitly flagged hard:true still wins. Soft
    // mismatches must NOT remove items (project rule: population /
    // eligibility mismatches reduce score, not discard results).
    const oppForFilter = {
      title: grantRow.title || '',
      description: rawOpp.description || '',
      sponsor: rawOpp.sponsor || '',
      keywords: Array.isArray(rawOpp.keywords) ? rawOpp.keywords : safeJson(rawOpp.keywords, []) || [],
      categories: Array.isArray(rawOpp.categories) ? rawOpp.categories : safeJson(rawOpp.categories, []) || [],
      eligibility_bullets: Array.isArray(rawOpp.eligibility_bullets)
        ? rawOpp.eligibility_bullets
        : safeJson(rawOpp.eligibility_bullets, []) || [],
      state: null,
      is_national: true,
      is_directory_resource: false,
      source: rawOpp.source || null,
      application_url: anyUrl || null,
      apply_url: anyUrl || null,
    }
    const profileDataForFilter = {
      primary_type: profile.primary_type || null,
      state: profileState,
      tags: Array.isArray(profile.tags) ? profile.tags : safeJson(profile.tags, []) || [],
    }
    const filterResult = applyRelevanceFilter(oppForFilter, profileDataForFilter, { mode: 'soft' })
    if (!filterResult.pass) {
      return {
        verdict: 'relevance_reject',
        reason: filterResult.reason || 'Hard relevance rule rejected',
        ruleId: filterResult.ruleId || 'goal2.relevance_filter_hard',
      }
    }
  }

  return { verdict: 'keep' }
}

const VERDICT_KEYS = [
  'keep',
  'source_disallowed',
  'dead_url',
  'duplicate_title',
  'wrong_state',
  'relevance_reject',
]

function emptyVerdictCounters() {
  const out = {}
  for (const k of VERDICT_KEYS) out[k] = 0
  return out
}

// Columns we'd LIKE to read off `funding_opportunities`. Some of them
// (entity_types_allowed, need_types_supported, opportunity_kind,
// evidence_url, verified_url, apply_url, etc.) are present on production
// Postgres but missing on older SQLite snapshots / readiness DBs. We
// introspect the live schema at startup and skip absent columns instead
// of hard-failing the audit on environments that haven't been migrated
// yet — the audit's rules treat unread columns as null which the
// matchEngine and dead-URL checks already tolerate (project rule:
// "null/missing fields default to neutral, not exclusionary").
const FO_COLUMN_CANDIDATES = [
  ['source', 'opp_source'],
  ['description', 'opp_description'],
  ['sponsor', 'opp_sponsor'],
  ['eligibility_bullets', 'opp_eligibility_bullets'],
  ['categories', 'opp_categories'],
  ['keywords', 'opp_keywords'],
  ['is_national', 'opp_is_national'],
  ['state', 'opp_state'],
  ['application_url', 'opp_application_url'],
  ['apply_url', 'opp_apply_url'],
  ['source_url', 'opp_source_url'],
  ['evidence_url', 'opp_evidence_url'],
  ['verified_url', 'opp_verified_url'],
  ['opportunity_kind', 'opp_kind'],
  ['record_origin', 'opp_record_origin'],
  ['is_loan', 'opp_is_loan'],
  ['deadline', 'opp_deadline'],
  ['deadline_type', 'opp_deadline_type'],
  ['funding_type', 'opp_funding_type'],
  ['opportunity_type', 'opp_opportunity_type'],
  ['entity_types_allowed', 'opp_entity_types_allowed'],
  ['need_types_supported', 'opp_need_types_supported'],
]

const GRANTS_COLUMN_CANDIDATES = [
  ['id', 'id'],
  ['title', 'title'],
  ['funder', 'funder'],
  ['notes', 'notes'],
  ['status', 'status'],
  ['deadline', 'deadline'],
  ['created_at', 'created_at'],
  ['application_url', 'application_url'],
  ['url', 'grant_url'],
  ['portal_url', 'portal_url'],
  ['profile_id', 'profile_id'],
  ['organization_id', 'organization_id'],
  ['funding_opportunity_id', 'funding_opportunity_id'],
]

async function listColumns(db, table) {
  try {
    const dialect = String(db?.dialect || '').toLowerCase()
    if (dialect === 'postgres') {
      const rows = await db
        .prepare(
          `SELECT column_name AS name FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = ?`,
        )
        .all(table)
      return new Set(rows.map((r) => String(r.name)))
    }
    const rows = await db.prepare(`PRAGMA table_info(${table})`).all()
    return new Set(rows.map((r) => String(r.name)))
  } catch {
    return new Set()
  }
}

async function buildSelectSql(db) {
  const grantsCols = await listColumns(db, 'grants')
  const foCols = await listColumns(db, 'funding_opportunities')

  const grantsSelect = GRANTS_COLUMN_CANDIDATES
    .filter(([col]) => grantsCols.has(col))
    .map(([col, alias]) => (col === alias ? `g.${col}` : `g.${col} AS ${alias}`))

  const foSelect = FO_COLUMN_CANDIDATES
    .filter(([col]) => foCols.size === 0 || foCols.has(col))
    .map(([col, alias]) => `fo.${col} AS ${alias}`)

  const selectClause = [...grantsSelect, ...foSelect].join(', ')
  // PROFILE SCOPE IS THE BOUNDARY (repo invariant: "no cross-profile /
  // cross-tenant bleed"; this file's own contract says duplicate_title means
  // "same title already seen earlier in THIS profile's pipeline").
  //
  // The org branch used to be a bare `g.organization_id = ?`, so every profile
  // sharing an organization pulled in EVERY org-mate's grants, judged them
  // against ITS OWN sections/state/seenTitles, and — in non-dry-run mode
  // (`POST /api/admin/clean-pipelines-against-goals` with `dry_run:false`) —
  // ran `DELETE FROM grants WHERE id = ?` on them. Two org-mates holding the
  // same real program was enough: the second row read as `duplicate_title` in
  // the first profile's pass and was deleted out of the OTHER profile's
  // pipeline. `wrong_state` had the same shape (profile A in TN deleting
  // profile B's Ohio grant).
  //
  // The branch exists to reach ORG-LEVEL ORPHANS — grants that belong to the
  // organization and name no profile (the `enforceProfileScopedPipeline`
  // legacy shape). Requiring `g.profile_id IS NULL` keeps exactly that reach
  // and removes the cross-profile bleed: a grant that explicitly names another
  // profile is never loaded, so it can never be classified or deleted here.
  return `
    SELECT ${selectClause}
    FROM grants g
    LEFT JOIN funding_opportunities fo ON fo.id = g.funding_opportunity_id
    WHERE g.profile_id = ?
       OR (g.profile_id IS NULL AND g.organization_id IS NOT NULL AND g.organization_id = ?)
    ORDER BY g.created_at ASC, g.id ASC
  `
}

/**
 * Audit every profile's pipeline against the mission goals.
 *
 * @param {object} db                 Async DB instance (sqlite or postgres).
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun=true] When true, no rows are deleted.
 * @returns {Promise<{
 *   dry_run: boolean,
 *   total_grants: number,
 *   profiles_with_pipeline: number,
 *   removed: number,
 *   kept: number,
 *   verdict_totals: object,
 *   per_profile: Array<{
 *     profile_id: string,
 *     display_name: string,
 *     primary_type: string,
 *     profile_state: string | null,
 *     total: number,
 *     verdicts: object,
 *     removed_items: Array<{ id: string, title: string, verdict: string, reason: string, ruleId?: string }>,
 *   }>,
 * }>}
 */
export async function auditPipelinesAgainstGoals(db, opts = {}) {
  if (!db) {
    return {
      dry_run: opts.dryRun !== false,
      total_grants: 0,
      profiles_with_pipeline: 0,
      removed: 0,
      kept: 0,
      verdict_totals: emptyVerdictCounters(),
      per_profile: [],
    }
  }

  const dryRun = opts.dryRun !== false

  let profiles = []
  try {
    profiles = await db
      .prepare('SELECT id, display_name, primary_type, organization_id, tags FROM profiles')
      .all()
  } catch (err) {
    log.warn(`[auditPipelinesAgainstGoals] failed to load profiles: ${err?.message}`)
    return {
      dry_run: dryRun,
      total_grants: 0,
      profiles_with_pipeline: 0,
      removed: 0,
      kept: 0,
      verdict_totals: emptyVerdictCounters(),
      per_profile: [],
    }
  }

  const verdictTotals = emptyVerdictCounters()
  const perProfile = []
  let totalGrants = 0
  let totalRemoved = 0

  const selectSql = await buildSelectSql(db)
  const selectStmt = db.prepare(selectSql)

  for (const profile of profiles) {
    let grants = []
    try {
      grants = await selectStmt.all(profile.id, profile.organization_id || '__none__')
    } catch (err) {
      log.warn(`[auditPipelinesAgainstGoals] grant load failed for ${profile.id}: ${err?.message}`)
      continue
    }
    if (grants.length === 0) continue

    let sectionRows = []
    try {
      sectionRows = await db
        .prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?')
        .all(profile.id)
    } catch (err) {
      log.warn(`[auditPipelinesAgainstGoals] section load failed for ${profile.id}: ${err?.message}`)
    }
    const sections = {}
    for (const r of sectionRows) {
      sections[r.section_key] = safeJson(r.data, {})
    }
    const profileForCtx = {
      id: profile.id,
      primary_type: profile.primary_type,
      tags: safeJson(profile.tags, []),
    }
    const profileState = deriveProfileState(profileForCtx, sections)
    const seenTitles = new Set()
    const verdicts = emptyVerdictCounters()
    const removedItems = []

    totalGrants += grants.length

    for (const g of grants) {
      const result = classifyPipelineItem(g, {
        profile: profileForCtx,
        sections,
        seenTitles,
      })
      verdicts[result.verdict] = (verdicts[result.verdict] || 0) + 1
      verdictTotals[result.verdict] = (verdictTotals[result.verdict] || 0) + 1

      if (result.verdict !== 'keep') {
        removedItems.push({
          id: g.id,
          title: g.title || '(untitled)',
          verdict: result.verdict,
          reason: result.reason || null,
          ruleId: result.ruleId || null,
        })
      }
    }

    if (!dryRun && removedItems.length > 0) {
      for (const item of removedItems) {
        try {
          await db.prepare('DELETE FROM grants WHERE id = ?').run(item.id)
          totalRemoved += 1
        } catch (err) {
          log.warn(`[auditPipelinesAgainstGoals] delete failed for grant ${item.id}: ${err?.message}`)
        }
      }
    } else {
      totalRemoved += removedItems.length
    }

    perProfile.push({
      profile_id: profile.id,
      display_name: profile.display_name || profile.id,
      primary_type: profile.primary_type || 'unknown',
      profile_state: profileState,
      total: grants.length,
      verdicts,
      removed_items: removedItems,
    })
  }

  return {
    dry_run: dryRun,
    total_grants: totalGrants,
    profiles_with_pipeline: perProfile.length,
    removed: totalRemoved,
    kept: totalGrants - totalRemoved,
    verdict_totals: verdictTotals,
    per_profile: perProfile,
  }
}
