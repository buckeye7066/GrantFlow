/**
 * funder990Ingest.js — bounded ingest of ITEMIZED 990 GRANTS for funders the
 * catalog already holds (the `source='propublica_990'` grantmaker rows).
 *
 * WHY. The 990 lane discovers FUNDERS but stores nothing about their giving,
 * so matching can only read the thin NTEE-derived row text. The itemized
 * grant lists funders file (990-PF Part XV, 990 Schedule I) are DEMONSTRATED
 * behavior — who they funded, where, for what, and at what size — and are
 * public, keyless data. This service reads them into `grant_transactions`
 * and enriches each funder row with an honest one-line giving summary, so
 * the canonical engine and sweeps score against evidence instead of silence.
 *
 * THE CHAIN (each link live-verified 2026-08-05, see config/funderBehavior.js):
 *   ProPublica org page (object ids) → GivingTuesday 990 data lake (raw IRS
 *   XML) → parseGrantTransactionsFromXml → grant_transactions.
 *
 * BURN/RETRY DISCIPLINE — the enforceAmountEnrichment rules, funder-scoped:
 *   - the burn mark (`attempted_at`) is written ONLY once the funder's ANSWER
 *     is known: a filing parsed (even to zero grants), or a stable
 *     no-org-page / no-e-file-XML fact;
 *   - TRANSIENT failures (5xx / network / timeout) spend NOTHING;
 *   - ENVIRONMENT failures (401/403/429 — a wall against OUR egress) spend
 *     env_attempts only, never the budget and never the burn;
 *   - stable-but-retryable outcomes (XML not yet mirrored in the lake, a
 *     parse error) spend `attempts`, and burn at FUNDER_990_MAX_ATTEMPTS;
 *   - candidates are excluded by SQL PREDICATE (attempted_at IS NULL AND
 *     attempts < max), ordered fewest-attempts-first — never a post-LIMIT
 *     JS filter (the #944 class), never retry-starvation.
 *
 * Env:
 *   ENFORCE_FUNDER_990_INGEST=0        count-only (no egress, no writes)
 *   FUNDER_990_INGEST_LIMIT            funders per run (default 3)
 *   FUNDER_990_INGEST_TIME_BUDGET_MS   wall budget (default 20000)
 *   FUNDER_990_MAX_ATTEMPTS            stable-retry bound (default 3)
 *   FUNDER_990_MAX_TX                  transactions kept per filing (default 5000)
 */
import {
  PROPUBLICA_ORG_PAGE_URL,
  EFILE_XML_URL,
  normalizeEin,
  isValidObjectId,
  extractObjectIdsFromOrgHtml,
  parseGrantTransactionsFromXml,
  needsEvidencedByPurpose,
  summarizeFunderGiving,
  mergeGivingSummaryIntoDescription,
  FUNDER_GIVING_MARKER,
} from '../../config/funderBehavior.js'

const DEFAULTS = Object.freeze({
  limit: 3,
  timeBudgetMs: 20_000,
  maxAttempts: 3,
  maxTransactions: 5000,
})

function intEnv(name, fallback) {
  const n = Number.parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function boolEnvDisabled(name) {
  const v = String(process.env[name] ?? '').trim().toLowerCase()
  return v === '0' || v === 'false' || v === 'off' || v === 'no'
}

async function tableExists(db, name) {
  try {
    if ((db?.dialect || 'sqlite') === 'postgres') {
      const r = await db.prepare('SELECT to_regclass(?) AS t').get(name)
      return Boolean(r?.t)
    }
    const r = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name)
    return Boolean(r?.name)
  } catch {
    return false
  }
}

/**
 * Default fetcher: two FIXED hosts only, URLs built exclusively from
 * sanitized identifiers (EIN = 9 digits, object id = 18 digits) — nothing
 * user-controlled ever reaches a URL, so this cannot be steered off-host.
 */
async function defaultFetch(url, { timeoutMs = 15_000 } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const resp = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'GrantFlow/1.0 (nonprofit funding research; contact: admin@axiombiolabs.org)' },
    })
    const text = await resp.text()
    return { status: resp.status, body: text }
  } finally {
    clearTimeout(timer)
  }
}

function classifyHttpFailure(status) {
  if (status === 401 || status === 403 || status === 429) return 'environment'
  if (status >= 500 || status === 408) return 'transient'
  return 'stable'
}

/**
 * Run one bounded ingest pass. Returns an honest census:
 * { scanned, ingested, transactions, enriched, burnedStable, spentAttempts,
 *   environment, transient, remaining, examples, truncated, enforced }
 */
export async function runFunder990Ingest(db, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? defaultFetch
  const limit = deps.limit ?? intEnv('FUNDER_990_INGEST_LIMIT', DEFAULTS.limit)
  const timeBudgetMs = deps.timeBudgetMs ?? intEnv('FUNDER_990_INGEST_TIME_BUDGET_MS', DEFAULTS.timeBudgetMs)
  const maxAttempts = deps.maxAttempts ?? intEnv('FUNDER_990_MAX_ATTEMPTS', DEFAULTS.maxAttempts)
  const maxTransactions = deps.maxTransactions ?? intEnv('FUNDER_990_MAX_TX', DEFAULTS.maxTransactions)
  const countOnly = boolEnvDisabled('ENFORCE_FUNDER_990_INGEST')

  if (!(await tableExists(db, 'grant_transactions')) || !(await tableExists(db, 'funder_990_ingest_state'))) {
    return { scanned: 0, ingested: 0, transactions: 0, enriched: 0, skipped: 'schema', enforced: false }
  }

  const isPg = (db?.dialect || 'sqlite') === 'postgres'
  const trueLit = isPg ? 'TRUE' : '1'
  const nowFn = isPg ? 'now()' : 'CURRENT_TIMESTAMP'

  // Candidate funders: active propublica_990 rows whose EIN has NOT been
  // answered, bounded in SQL, fewest-attempts-first. DISTINCT on the EIN —
  // one funder may back several catalog rows and one filing answers them all.
  let candidates
  try {
    candidates = await db
      .prepare(
        `SELECT fo.source_id AS ein,
                MIN(fo.sponsor) AS sponsor,
                COALESCE(MAX(s.attempts), 0) AS attempts
           FROM funding_opportunities fo
           LEFT JOIN funder_990_ingest_state s ON s.funder_ein = fo.source_id
          WHERE fo.source = 'propublica_990'
            AND (fo.is_active IS NULL OR fo.is_active = ${trueLit})
            AND LENGTH(COALESCE(fo.source_id, '')) = 9
            AND s.attempted_at IS NULL
            AND COALESCE(s.attempts, 0) < ?
          GROUP BY fo.source_id
          ORDER BY COALESCE(MAX(s.attempts), 0) ASC, MIN(fo.created_at) ASC
          LIMIT ?`,
      )
      .all(maxAttempts, limit)
  } catch (err) {
    return { scanned: 0, ingested: 0, transactions: 0, enriched: 0, skipped: `query:${String(err?.message || err)}`, enforced: false }
  }

  const started = Date.now()
  const summary = {
    scanned: 0,
    ingested: 0,
    transactions: 0,
    enriched: 0,
    burnedStable: 0,
    spentAttempts: 0,
    environment: 0,
    transient: 0,
    examples: [],
    truncated: false,
    enforced: !countOnly,
  }

  if (countOnly) {
    summary.remaining = (candidates ?? []).length
    return summary
  }

  const upsertState = async (ein, fields) => {
    const existing = await db.prepare('SELECT funder_ein FROM funder_990_ingest_state WHERE funder_ein = ?').get(ein)
    if (existing) {
      const sets = Object.keys(fields).map((k) => `${k} = ?`).join(', ')
      await db
        .prepare(`UPDATE funder_990_ingest_state SET ${sets}, updated_at = ${nowFn} WHERE funder_ein = ?`)
        .run(...Object.values(fields), ein)
    } else {
      const cols = ['funder_ein', ...Object.keys(fields)]
      const marks = cols.map(() => '?').join(', ')
      await db
        .prepare(`INSERT INTO funder_990_ingest_state (${cols.join(', ')}) VALUES (${marks})`)
        .run(ein, ...Object.values(fields))
    }
  }

  const spendAttempt = async (ein, prevAttempts, reason) => {
    summary.spentAttempts += 1
    const attempts = (Number(prevAttempts) || 0) + 1
    const fields = { attempts, last_reason: reason }
    if (attempts >= maxAttempts) {
      // Exhausted: the bound converts "keep retrying forever" into a visible,
      // final state (the row self-documents why via last_reason).
      summary.burnedStable += 1
      await upsertState(ein, { ...fields, attempted_at: new Date().toISOString() })
    } else {
      await upsertState(ein, fields)
    }
  }

  for (const cand of candidates ?? []) {
    if (Date.now() - started > timeBudgetMs) {
      summary.truncated = true
      break
    }
    const ein = normalizeEin(cand.ein)
    if (!ein) continue
    summary.scanned += 1

    // 1) org page → object ids
    let page
    try {
      page = await fetchImpl(PROPUBLICA_ORG_PAGE_URL(ein), {})
    } catch {
      summary.transient += 1
      await upsertState(ein, { last_reason: 'org_page_network' })
      continue
    }
    if (page.status !== 200) {
      const cls = classifyHttpFailure(page.status)
      if (cls === 'environment') {
        summary.environment += 1
        const prev = await db.prepare('SELECT env_attempts FROM funder_990_ingest_state WHERE funder_ein = ?').get(ein)
        await upsertState(ein, {
          env_attempts: (Number(prev?.env_attempts) || 0) + 1,
          last_reason: `org_page_blocked:${page.status}`,
        })
      } else if (cls === 'transient') {
        summary.transient += 1
        await upsertState(ein, { last_reason: `org_page_transient:${page.status}` })
      } else {
        // A 404 org page is a REAL answer about this EIN.
        summary.burnedStable += 1
        await upsertState(ein, { attempted_at: new Date().toISOString(), last_reason: `org_page_${page.status}` })
      }
      continue
    }
    const objectIds = extractObjectIdsFromOrgHtml(page.body).filter(isValidObjectId)
    if (!objectIds.length) {
      // A page with no e-file XML links is a REAL answer: paper filer / no
      // e-file — there is no itemized-grant XML to read for this funder.
      summary.burnedStable += 1
      await upsertState(ein, { attempted_at: new Date().toISOString(), last_reason: 'no_efile_xml' })
      continue
    }

    // 2) newest filing XML from the data lake (fall back down the list only on
    //    lake-404 — an older filing is still demonstrated behavior).
    let xml = null
    let usedObjectId = null
    let lake404s = 0
    let interrupted = false
    for (const oid of objectIds.slice(0, 3)) {
      let resp
      try {
        resp = await fetchImpl(EFILE_XML_URL(oid), {})
      } catch {
        summary.transient += 1
        await upsertState(ein, { last_reason: 'lake_network' })
        interrupted = true
        break
      }
      if (resp.status === 200) {
        xml = resp.body
        usedObjectId = oid
        break
      }
      if (resp.status === 404) {
        lake404s += 1
        continue
      }
      const cls = classifyHttpFailure(resp.status)
      if (cls === 'environment') {
        summary.environment += 1
        const prev = await db.prepare('SELECT env_attempts FROM funder_990_ingest_state WHERE funder_ein = ?').get(ein)
        await upsertState(ein, {
          env_attempts: (Number(prev?.env_attempts) || 0) + 1,
          last_reason: `lake_blocked:${resp.status}`,
        })
      } else {
        summary.transient += 1
        await upsertState(ein, { last_reason: `lake_transient:${resp.status}` })
      }
      interrupted = true
      break
    }
    if (interrupted) continue
    if (!xml) {
      // Every tried object id is missing from the lake: stable-but-retryable
      // (the lake backfills new filings) — spends an attempt, burns at the bound.
      if (lake404s > 0) await spendAttempt(ein, cand.attempts, 'xml_not_in_lake')
      continue
    }

    // 3) parse → transactions
    let parsed
    try {
      parsed = parseGrantTransactionsFromXml(xml, { maxTransactions })
    } catch (err) {
      await spendAttempt(ein, cand.attempts, `xml_parse_error:${String(err?.message || err).slice(0, 80)}`)
      continue
    }

    // ANSWERED — even zero itemized grants is the funder's real answer.
    try {
      await db.prepare('DELETE FROM grant_transactions WHERE source_object_id = ?').run(usedObjectId)
      let seq = 0
      for (const tx of parsed.transactions) {
        await db
          .prepare(
            `INSERT INTO grant_transactions
               (id, funder_ein, funder_name, recipient_name, recipient_ein, recipient_city,
                recipient_state, recipient_country, amount, purpose, tax_year, form_type, source_object_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            `990tx:${usedObjectId}:${seq}`,
            ein,
            parsed.filerName ?? cand.sponsor ?? null,
            tx.recipient_name,
            tx.recipient_ein,
            tx.recipient_city,
            tx.recipient_state,
            tx.recipient_country,
            tx.amount,
            tx.purpose,
            parsed.taxYear,
            parsed.formType,
            usedObjectId,
          )
        seq += 1
      }
      summary.transactions += seq
      summary.ingested += 1
      await upsertState(ein, {
        attempted_at: new Date().toISOString(),
        last_reason: seq === 0 ? 'no_itemized_grants' : parsed.truncated ? 'parsed_truncated' : 'parsed',
        ingested_object_id: usedObjectId,
        tax_year: parsed.taxYear,
        transactions_found: seq,
      })
      if (summary.examples.length < 3) {
        summary.examples.push(`${parsed.filerName ?? ein}: ${seq} grants (TY ${parsed.taxYear ?? '?'})`)
      }
    } catch (err) {
      // A write failure must NOT burn: we did not persist the answer (the
      // mark-after-write rule). last_reason records what happened.
      summary.transient += 1
      await upsertState(ein, { last_reason: `write_failed:${String(err?.message || err).slice(0, 80)}` })
      continue
    }

    // 4) enrich the funder's catalog rows with the demonstrated-giving line and
    //    the needs its purposes evidence. Additive only: categories are merged,
    //    never removed; the summary line is marker-idempotent.
    if (parsed.transactions.length > 0) {
      const evidenced = new Set()
      for (const tx of parsed.transactions) {
        for (const need of needsEvidencedByPurpose(tx.purpose)) evidenced.add(need)
      }
      const summaryLine = summarizeFunderGiving({ taxYear: parsed.taxYear, transactions: parsed.transactions })
      try {
        const rows = await db
          .prepare(
            `SELECT id, description, categories FROM funding_opportunities
              WHERE source = 'propublica_990' AND source_id = ?`,
          )
          .all(ein)
        for (const row of rows ?? []) {
          const nextDescription = mergeGivingSummaryIntoDescription(row.description, summaryLine)
          let cats = []
          try {
            const parsedCats = JSON.parse(row.categories ?? '[]')
            if (Array.isArray(parsedCats)) cats = parsedCats
          } catch {
            cats = []
          }
          const merged = [...new Set([...cats, ...evidenced])]
          await db
            .prepare(`UPDATE funding_opportunities SET description = ?, categories = ?, updated_at = ${nowFn} WHERE id = ?`)
            .run(nextDescription, JSON.stringify(merged), row.id)
          summary.enriched += 1
        }
      } catch {
        // enrichment is additive polish; a failure never un-answers the funder
      }
    }
  }

  return summary
}

export default { runFunder990Ingest, FUNDER_GIVING_MARKER }
