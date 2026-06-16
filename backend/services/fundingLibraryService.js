/**
 * Funding Library Service
 *
 * The Funding Library is the user-facing read-only view of every verified
 * funding opportunity GrantFlow has ingested into the general resources
 * pool. It is *not* a profile pipeline — adding an opportunity to a
 * profile pipeline goes through the existing canonical accept-recommendation
 * path, not through this service.
 *
 * Reads from `funding_opportunities`, the canonical opportunity store.
 * Filters are SQL-parameterised; no string concatenation of user input.
 *
 * Mission rules honoured here:
 *   - Directory-style records (type='DIRECTORY' / opportunity_kind='directory')
 *     always survive filtering unless the caller explicitly asks for
 *     `kind=direct_only`. They are valuable referral resources.
 *   - Loans + matching-funds-only records are excluded from the default
 *     view but reachable with `include_loans=1`.
 *   - Hidden records (`is_hidden=1`) are excluded.
 *
 * Returned shape stays stable so the table component can render rows
 * without a per-row guard.
 */

import { withProfileScope } from '../middleware/profileContext.js'

const VALID_SORTS = new Set(['discovered_at', 'last_verified_at', 'deadline', 'amount_max'])

/**
 * @param {object} db
 * @param {object} opts  query opts (see route handler)
 * @returns {Promise<{
 *   total: number,
 *   items: Array<object>,
 *   facets: object,
 *   filters_applied: object,
 * }>}
 */
export async function listFundingLibrary(db, opts = {}) {
  if (!db) {
    return { total: 0, items: [], facets: defaultFacets(), filters_applied: opts }
  }

  const where = []
  const args = []

  // Default: only verified, non-hidden opportunities. Verified means we have
  // either a successful link probe or a curated source trust.
  where.push("(is_hidden = 0 OR is_hidden IS NULL)")
  if (!opts.include_unverified) {
    where.push("(link_status IN ('ok','redirect') OR record_origin IN ('curated_verified','curated_benefits','curated_program','curated_catalog','school_portal','grants_gov','verified_real','manual'))")
  }
  if (!opts.include_loans) {
    where.push("(opportunity_type IS NULL OR LOWER(opportunity_type) NOT IN ('loan','matching_fund'))")
  }
  if (opts.kind === 'direct_only') {
    where.push("(opportunity_kind IS NULL OR opportunity_kind = 'direct')")
  }

  if (opts.state) {
    const s = String(opts.state).toUpperCase()
    where.push('(state = ? OR is_national = 1)')
    args.push(s)
  }
  if (opts.applicant_type) {
    // categories is a JSON array; we use LIKE on the serialised text as a
    // best-effort filter — exact filtering happens at match time, this is
    // just for browsing.
    where.push("(categories LIKE ? OR keywords LIKE ?)")
    args.push(`%"${String(opts.applicant_type)}"%`, `%"${String(opts.applicant_type)}"%`)
  }
  if (opts.category) {
    where.push("categories LIKE ?")
    args.push(`%"${String(opts.category)}"%`)
  }
  if (opts.q) {
    const like = `%${String(opts.q).toLowerCase()}%`
    where.push("(LOWER(title) LIKE ? OR LOWER(sponsor) LIKE ? OR LOWER(description) LIKE ?)")
    args.push(like, like, like)
  }
  if (opts.deadline === 'open' || opts.deadline === 'rolling') {
    where.push("deadline_type IN ('rolling','ongoing')")
  } else if (opts.deadline === 'soon') {
    where.push("deadline IS NOT NULL AND deadline >= DATE('now') AND deadline <= DATE('now', '+30 day')")
  } else if (opts.deadline === 'expired_excluded') {
    where.push("(deadline IS NULL OR deadline >= DATE('now'))")
  }
  if (opts.source_trust) {
    where.push('source_trust_tier = ?')
    args.push(String(opts.source_trust))
  }
  if (opts.record_origin) {
    where.push('record_origin = ?')
    args.push(String(opts.record_origin))
  }

  const sortBy = VALID_SORTS.has(opts.sort) ? opts.sort : 'discovered_at'
  const sortDir = String(opts.sort_dir || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC'
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 200)
  const offset = Math.max(Number(opts.offset) || 0, 0)
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : ''

  return withProfileScope({ bypass: true }, async () => {
    const totalRow = await db
      .prepare(`SELECT COUNT(*) AS n FROM funding_opportunities ${whereClause}`)
      .get(...args)
    const total = Number(totalRow?.n || 0)

    const sql = `
      SELECT id, title, sponsor, source, source_url, source_trust_tier,
             record_origin, description,
             amount_min, amount_max, amount_description,
             deadline, deadline_type,
             application_url, apply_url,
             is_national, state, categories, keywords,
             opportunity_type, funding_type, opportunity_kind, type,
             link_status, link_status_code, last_verified_at,
             discovered_at, created_at, updated_at
        FROM funding_opportunities
        ${whereClause}
        ORDER BY ${sortBy} ${sortDir} NULLS LAST
        LIMIT ? OFFSET ?
    `.replace('NULLS LAST', '') // SQLite handles NULLs differently; harmless to drop
    const rows = await db.prepare(sql).all(...args, limit, offset)
    const items = rows.map(decodeRow)
    const facets = await buildFacets(db, whereClause, args)

    return {
      total,
      items,
      facets,
      filters_applied: {
        state: opts.state || null,
        applicant_type: opts.applicant_type || null,
        category: opts.category || null,
        q: opts.q || null,
        deadline: opts.deadline || null,
        source_trust: opts.source_trust || null,
        kind: opts.kind || null,
        include_unverified: Boolean(opts.include_unverified),
        include_loans: Boolean(opts.include_loans),
        sort: sortBy,
        sort_dir: sortDir.toLowerCase(),
        limit,
        offset,
      },
    }
  })
}

/**
 * Single-record detail for the Funding Library detail panel.
 * Returns null when not found.
 */
export async function getFundingLibraryItem(db, id) {
  if (!db || !id) return null
  return withProfileScope({ bypass: true }, async () => {
    const row = await db
      .prepare('SELECT * FROM funding_opportunities WHERE id = ? LIMIT 1')
      .get(String(id))
    return row ? decodeRow(row) : null
  })
}

async function buildFacets(db, whereClause, args) {
  // Compact facet counts so the filter sidebar can show "OH (12), TX (4)…"
  // without an extra round-trip per filter.
  const sqlByState = `
    SELECT state, COUNT(*) AS n
      FROM funding_opportunities
      ${whereClause}
      GROUP BY state
      ORDER BY n DESC
      LIMIT 25
  `
  const sqlByOrigin = `
    SELECT record_origin, COUNT(*) AS n
      FROM funding_opportunities
      ${whereClause}
      GROUP BY record_origin
      ORDER BY n DESC
      LIMIT 15
  `
  const sqlByTrust = `
    SELECT source_trust_tier, COUNT(*) AS n
      FROM funding_opportunities
      ${whereClause}
      GROUP BY source_trust_tier
      ORDER BY n DESC
      LIMIT 15
  `

  try {
    const states = await db.prepare(sqlByState).all(...args)
    const origins = await db.prepare(sqlByOrigin).all(...args)
    const trusts = await db.prepare(sqlByTrust).all(...args)
    return {
      by_state: states.map((r) => ({ state: r.state || 'national', count: Number(r.n || 0) })),
      by_origin: origins.map((r) => ({ origin: r.record_origin || 'unknown', count: Number(r.n || 0) })),
      by_trust: trusts.map((r) => ({ tier: r.source_trust_tier || 'unknown', count: Number(r.n || 0) })),
    }
  } catch {
    return defaultFacets()
  }
}

function defaultFacets() {
  return { by_state: [], by_origin: [], by_trust: [] }
}

function decodeRow(row) {
  if (!row) return null
  return {
    ...row,
    categories: parseJsonArray(row.categories),
    keywords: parseJsonArray(row.keywords),
    is_national: row.is_national === true || row.is_national === 1,
  }
}

function parseJsonArray(v) {
  if (!v) return []
  if (Array.isArray(v)) return v
  try {
    const parsed = JSON.parse(v)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export const __testables = { defaultFacets, parseJsonArray }
