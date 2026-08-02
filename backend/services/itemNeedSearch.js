/**
 * itemNeedSearch.js — ON-DEMAND ITEM SEARCH for one item or a list of items.
 *
 * THE OWNER'S RULE (2026-08-02): "have the item search crawler tooled to be
 * able to find those items if the profile owner or admin requires a crawl for
 * that item or list of items."
 *
 * WHAT WAS ACTUALLY BROKEN (measured 2026-08-02, not inferred):
 *
 *   `src/pages/DataSources.jsx` renders an "Item Funding" tool with a REQUIRED
 *   free-text "Item request" box; `src/api/crawlers.js:200` puts it on the wire
 *   as `item_request`; and `POST /api/real-crawlers/run` destructures
 *   `const { crawler_type, profile_id, min_match_score } = req.body` — the item
 *   is DROPPED on the floor. `crawlerType` then travels through
 *   `runProfileDiscoveryLive` to exactly ONE consumer:
 *   `persistSourceCoverage({ crawlerType })`, a telemetry label. So typing
 *   "PROBE ethics class" and pressing the button ran a generic profile crawl
 *   and reported its count as the item's answer.
 *
 *   The 1,148-line `services/crawlers/itemFundingCrawler.js` — which holds real
 *   NCSBN PROBE / nurse-reentry / vocational-rehab sources under a
 *   `license_reinstatement` key — is reachable from NOTHING: its only product
 *   caller (`routes/admin.js`) imports `crawlItemFunding` from
 *   `services/crawlerOsCompatibility.js`, where the whole body is
 *   `return { ...SUPERSEDED, items: [] }`. It is also on
 *   `scripts/check-runtime-imports.mjs`'s legacy list, so it CANNOT be imported
 *   back into the runtime. `services/itemCrawler.js` (326 lines) and
 *   `services/itemGiftCrawler.js` (213 lines) have zero runtime importers.
 *
 * SO THIS LANE IS BUILT ON THE MACHINERY THAT DEMONSTRABLY RUNS: the same
 * `needTaxonomy` (whose `license_reinstatement` entry already carries 'PROBE
 * ethics class', 'board-required ethics course', 'nurse re-entry', …) and the
 * same `liveWebSearch.searchNeedWebLeads` ladder that `POST
 * /api/real-crawlers/specific-need` uses today.
 *
 * TWO LANES, HONESTLY SEPARATED.
 *   CATALOG  — rows ALREADY surfaced to THIS profile by the canonical engine
 *              (`profile_opportunity_matches`, `SURFACED_MATCHER_VERSIONS_SQL`)
 *              whose own text states the item. These carry a real engine
 *              decision; we re-rank, we never re-decide.
 *   WEB      — live search leads. Display-only, `record_origin='web_search'`,
 *              never ingested from here and never given an `application_url`
 *              (canonical G0: no invented facts).
 *
 * NO PADDING. `itemFundingCrawler`'s "ZERO-RESULT SAFETY NET" appended broad
 * funder directories (Candid, GrantWatch, Grants.gov) whenever a search found
 * nothing, labeled "Shown because no exact item match was found". A person who
 * needs one specific class is not served by four directories; that is the
 * flood the owner rejected. `found: 0` is returned as `found: 0`.
 *
 * AWARDABLE vs POINTER is read from the REGISTRY (`config/opportunityKindClasses
 * .isPointerKind`), never a hand-typed kind list — that exact bug shipped three
 * times this week.
 *
 * NOTHING HERE WRITES. The catalog lane is a SELECT; the web lane is a search.
 * This is deliberate: an on-demand item probe must be safe to run repeatedly on
 * one profile without moving the rolling match snapshot underneath it.
 */

import { expandNeed, scoreNeedMatch } from './shared/needTaxonomy.js'
import { computeMatchDecision } from './matchEngine.js'
import { searchNeedWebLeads } from './shared/liveWebSearch.js'
import { SURFACED_MATCHER_VERSIONS_SQL } from '../config/matchSurfacing.js'
import { isPointerKind } from '../config/opportunityKindClasses.js'
import { isWebDiscoveryEnabled } from './crawlerOsService.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('itemNeedSearch')

/**
 * Minimum need score for a row to be REPORTED as an answer to the item.
 * `scoreNeedMatch` credits a canonical-need hit plus per-synonym overlap, so a
 * row that merely shares the profile's own topic scores low and is refused.
 * The value matches the live `/specific-need` web-lead floor so the two lanes
 * cannot drift into different notions of "relevant to this item".
 */
export const ITEM_NEED_MIN_SCORE = Number(process.env.ITEM_NEED_MIN_SCORE) || 10

/** Per-item bounds — an item list must not become an unbounded fan-out. */
export const ITEM_SEARCH_MAX_ITEMS = Number(process.env.ITEM_SEARCH_MAX_ITEMS) || 5
export const ITEM_SEARCH_CATALOG_SCAN = Number(process.env.ITEM_SEARCH_CATALOG_SCAN) || 400
export const ITEM_SEARCH_MAX_RESULTS = Number(process.env.ITEM_SEARCH_MAX_RESULTS) || 12

/**
 * `funding_opportunities.is_active` is INTEGER on SQLite and BOOLEAN on prod
 * Postgres — the schema-drift class CLAUDE.md documents twice (`no such column:
 * fo.url`, `application_missing_info.resolved`). A literal `fo.is_active = 1`
 * unit-tests green on SQLite and throws `operator does not exist: boolean =
 * integer` in prod, silently degrading this search to web-only. Measured live
 * against prod on 2026-08-02 — that is exactly what the first draft did.
 */
function activePredicate(db) {
  return db?.dialect === 'postgres'
    ? '(fo.is_active IS NULL OR fo.is_active = TRUE)'
    : '(fo.is_active IS NULL OR fo.is_active = 1)'
}

/**
 * `funding_opportunities.categories` / `.keywords` are stored as JSON TEXT, not
 * as arrays. `scoreNeedMatch` calls `.join(' ')` on whatever it is handed, so
 * passing the raw column throws `(program.categories || []).join is not a
 * function` — observed live against prod 2026-08-02.
 */
function parseArrayField(v) {
  if (Array.isArray(v)) return v
  if (typeof v !== 'string' || !v.trim()) return []
  try { const p = JSON.parse(v); return Array.isArray(p) ? p : [] } catch { return [] }
}

/** The row's kind, or null when it declares none (empty/whitespace count as none). */
function declaredKind(kind) {
  const k = String(kind ?? '').trim()
  return k ? k : null
}

/** Lowercase, punctuation → space, collapsed. */
function norm(v) {
  return String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Stopwords for BIGRAM construction. Kept local and deliberately small: this
 * governs only whether two adjacent words may form an endorsing phrase, and a
 * bigram spanning a filler word is not a phrase anyone wrote.
 */
const PHRASE_STOPWORDS = new Set([
  'for', 'the', 'and', 'with', 'from', 'that', 'this', 'a', 'an', 'of', 'to',
  'help', 'need', 'needs', 'want', 'get', 'pay', 'paying', 'find', 'my', 'our',
  'your', 'me', 'i', 'is', 'are', 'be', 'in', 'on', 'at', 'or',
])

/**
 * THE PHRASE-ENDORSEMENT GATE — the precision rule of this whole lane.
 *
 * `scoreNeedMatch` credits 5 points per single-word "must term" hit, so any two
 * bare words of the request reach the floor. Measured live against prod on
 * 2026-08-02 for "PROBE Ethics class for nursing licensure", the words `probe`
 * + `class` alone admitted, as funding results:
 *
 *   NASA "STROBE-X: A Probe-Class Mission for X-Ray Spectroscopy"
 *   CBC  "Conservatives call for a 2nd Morneau ethics probe"
 *   LinkedIn "Probe Group" (automotive/mining, South Africa)
 *   aiwolfie.online "Gemini 3.5 Flash Jailbreak" ("per-probe-class deviation")
 *
 * A row must therefore state a PHRASE, never a scatter of words — the same
 * multi-word rule `profileDerivedFacts.isTopicalTerm` settled on after single
 * words dragged generic vocabulary back into the recall key. Three sources
 * supply the phrases, and all three are DERIVED (from the taxonomy entry the
 * request matched, or from the request itself) — none is hand-typed here:
 *
 *   1. multi-word SYNONYMS of the matched taxonomy entry
 *      ('probe ethics class', 'board-required ethics course', 'nurse re-entry')
 *   2. the matched taxonomy phrase itself, when multi-word
 *   3. stopword-free BIGRAMS of what the user actually typed
 *      ('probe ethics', 'ethics class', 'nursing licensure')
 *
 * Bigrams come from ADJACENT raw tokens and any bigram containing a stopword is
 * discarded, so "class for nursing" never becomes a phrase. Direction is
 * PHRASE ⊂ TEXT with token boundaries: "ethics probe" does not satisfy "probe
 * ethics", which is precisely what refuses the CBC story.
 */
export function buildEndorsementPhrases(itemText, expanded) {
  const phrases = new Set()
  for (const syn of expanded?.synonyms ?? []) {
    const s = norm(syn)
    if (s.includes(' ')) phrases.add(s)
  }
  const key = norm(expanded?.matchedKey)
  if (key.includes(' ')) phrases.add(key)

  // Bigrams of the raw request, stopword-free.
  const tokens = norm(itemText).split(' ').filter(Boolean)
  for (let i = 0; i + 1 < tokens.length; i += 1) {
    const a = tokens[i]
    const b = tokens[i + 1]
    if (PHRASE_STOPWORDS.has(a) || PHRASE_STOPWORDS.has(b)) continue
    if (a.length < 3 || b.length < 3) continue
    phrases.add(`${a} ${b}`)
  }
  return [...phrases]
}

/** Does this row's own text state one of the endorsing phrases? */
export function statesEndorsingPhrase(text, phrases) {
  const hay = ` ${norm(text)} `
  for (const p of phrases) {
    if (p && hay.includes(` ${p} `)) return p
  }
  return null
}

/**
 * FUNDING INTENT — the SECOND condition a WEB LEAD must satisfy.
 *
 * TWO CONDITIONS MUST BOTH HOLD, the shape `enforceLeadContactPlausibility`
 * settled on after a one-condition floor shipped and 8 of 10 live drafts still
 * went to the wrong organization. A phrase alone is not enough, because a
 * two-word phrase built from common English words is a coincidence magnet:
 * measured live against prod 2026-08-02, the taxonomy synonym 'PROBE class'
 * was satisfied verbatim by NASA's "STROBE-X: A Probe-Class Mission for X-Ray
 * Spectroscopy" and by an AI-jailbreak blog's "per-probe-class deviation
 * table". Both state the phrase. Neither has anything to do with paying for
 * anything.
 *
 * The question this lane exists to answer is "WHO WILL PAY FOR THIS", so a page
 * that never mentions money, eligibility, or applying is not an answer to it —
 * whatever phrases it happens to contain.
 *
 * WHY THIS LIST IS NEW RATHER THAN IMPORTED: the repo's rule is to consume an
 * existing registry and never hand-type a subset, and there is genuinely no
 * funding-intent vocabulary anywhere in it (`genericTitleVocabulary` enumerates
 * the OPPOSITE — titles too generic to be a match; `opportunityRealityGate`
 * decides URL/placeholder shape, not page semantics). So this is a NEW single
 * source with a totality test, which is what the enumerable-inventory rule
 * asks for. Every term below was checked against the real prod SERP for
 * "PROBE Ethics class for nursing licensure" — a measured list, not a guessed
 * one.
 *
 * CATALOG ROWS ARE EXEMPT, deliberately. A `funding_opportunities` row already
 * passed the reality gate and carries a `computeMatchDecision` verdict for this
 * profile; a raw SERP snippet has passed nothing. Applying a money-word filter
 * to catalog rows would drop real funders whose stored description is thin —
 * silence is not a denial.
 */
export const FUNDING_INTENT_TERMS = Object.freeze([
  'grant', 'grants', 'scholarship', 'scholarships', 'fellowship', 'bursary',
  'fund', 'funds', 'funding', 'financial aid', 'financial assistance',
  'assistance', 'award', 'awards', 'stipend', 'voucher', 'vouchers',
  'reimburse', 'reimbursement', 'tuition', 'fee', 'fees', 'cost', 'costs',
  'price', 'pricing', 'pay', 'payment', 'sponsor', 'sponsorship', 'subsidy',
  'subsidized', 'waiver', 'waived', 'no cost', 'free of charge', 'low cost',
  'eligible', 'eligibility', 'apply', 'application', 'donat', 'charitable',
])

/** Does this text state any funding/cost intent at all? Returns the hit or null. */
export function statesFundingIntent(text) {
  const raw = String(text ?? '')
  if (/\$\s?\d/.test(raw)) return '$'
  const hay = ` ${norm(raw)} `
  for (const t of FUNDING_INTENT_TERMS) {
    const n = norm(t)
    if (n && hay.includes(` ${n} `)) return n
  }
  // Prefix-style terms ('donat' → donation/donated/donate, 'reimburse' → -ment)
  for (const t of ['donat', 'reimburse', 'subsid', 'eligib', 'sponsor']) {
    if (hay.includes(` ${t}`)) return t
  }
  return null
}

/**
 * SQL LIKE patterns for candidate discovery.
 *
 * CANDIDATE DISCOVERY IS A SQL PREDICATE, NEVER A POST-`LIMIT` JS FILTER (the
 * #944 "green while doing nothing" signature). A profile can carry hundreds of
 * surfaced matches; selecting the first N and then filtering in JS would let
 * rows that never mention the item permanently starve the ones that do.
 *
 * The patterns are a deliberate SUPERSET — `scoreNeedMatch` adjudicates each
 * returned row, exactly as `profileDerivedFacts.termLikePattern` feeds
 * `titleStatesTerm`.
 */
export function buildItemLikeTerms(itemText, expanded) {
  const terms = new Set()
  const raw = norm(itemText)
  if (raw) terms.add(raw)
  // The taxonomy phrase that matched strips filler ("help to pay for an …").
  const matchedKey = norm(expanded?.matchedKey)
  if (matchedKey) terms.add(matchedKey)
  // Multi-word synonyms only. A single generic word ("license", "training")
  // is a coincidence magnet — the same rule `isTopicalTerm` enforces.
  for (const syn of expanded?.synonyms ?? []) {
    const s = norm(syn)
    if (s.includes(' ') && s.length >= 5) terms.add(s)
    if (terms.size >= 12) break
  }
  return [...terms].filter(Boolean)
}

/**
 * CATALOG LANE — every ACTIVE catalog row whose own text states the item,
 * adjudicated for THIS profile by the canonical engine.
 *
 * WHY THIS SCANS THE CATALOG AND NOT JUST THE MATCH STORE. The first draft read
 * only `profile_opportunity_matches`, on the reasoning that a stored row already
 * carries a real verdict. Measured read-only against prod on 2026-08-02, that
 * reasoning fails on exactly the case this feature exists for:
 *
 *   Dr. John Robert White (`profile-john-white`) declares
 *   `occupation.healthcare_worker_type = "RN"` and carries 212 surfaced
 *   matches. NOT ONE of them mentions nursing licensure. Meanwhile the catalog
 *   holds a purpose-built, curated license-reinstatement set created
 *   2026-04-09 — "WIOA Individual Training Accounts — License Reinstatement &
 *   Remediation Tuition", "State Nursing Associations — License Reinstatement
 *   Assistance & Advocacy", "American Job Centers — Professional License
 *   Reinstatement Training", "American Nurses Association — Return to Practice
 *   & Reinstatement Resources", "VA Chapter 31 — Veteran Readiness &
 *   Employment (training & licensure)" — and EVERY ONE of those rows has
 *   `COUNT(*) FROM profile_opportunity_matches = 0`. Fleet-wide. They have
 *   never reached a single profile since the day they were created.
 *
 * The match store is a ROLLING SNAPSHOT (CLAUDE.md: `crawlerOsPersistence`'s
 * reconcile DELETEs a profile's rows every run and re-inserts only what THAT
 * run re-found), so "no stored row" is not evidence of "not a match" — it is
 * evidence that no run happened to re-find it. Restricting an ON-DEMAND item
 * search to that snapshot means the owner asks "who pays for a PROBE ethics
 * class" and GrantFlow answers from a catalog it refuses to look at.
 *
 * THE ENGINE STAYS THE SOLE AUTHORITY. A row with no stored decision is scored
 * LIVE by `computeMatchDecision`, and a REJECT is dropped — the exact fallback
 * `recheckHamiltonPolicyStops` and the funding-sources route already use for
 * the same rolling-snapshot reason. Nothing here invents an endorsement, and
 * nothing here is persisted: the surfaced decision is labeled
 * `matcher_version: 'live-item-search'` so a reader can always tell a stored
 * verdict from one computed for this request.
 */
async function searchCatalogLane(db, { profileId, itemText, expanded, phrases, profileContext }) {
  const terms = buildItemLikeTerms(itemText, expanded)
  if (terms.length === 0) return { results: [], scanned: 0, terms, refusedNoPhrase: 0, refusedByEngine: 0, liveScored: 0 }

  const like = terms.map(
    () => `(LOWER(COALESCE(fo.title,'')) LIKE ? OR LOWER(COALESCE(fo.description,'')) LIKE ? OR LOWER(COALESCE(fo.keywords,'')) LIKE ?)`,
  ).join(' OR ')
  const params = terms.flatMap((t) => {
    const p = `%${t.replace(/[%_\\]/g, '\\$&')}%`
    return [p, p, p]
  })

  let rows = []
  try {
    // CANDIDATE DISCOVERY IS A SQL PREDICATE. The item terms are in the WHERE
    // clause and the LIMIT is applied after it, so a catalog of thousands can
    // never starve the rows that actually state the item (#944).
    rows = await db.prepare(
      `SELECT fo.id, fo.title, fo.sponsor, fo.description, fo.keywords, fo.categories,
              fo.application_url, fo.source_url, fo.opportunity_kind, fo.deadline,
              fo.amount_min, fo.amount_max, fo.state, fo.record_origin,
              m.match_score, m.match_decision, m.match_explanation, m.matcher_version
         FROM funding_opportunities fo
         LEFT JOIN profile_opportunity_matches m
                ON m.opportunity_id = fo.id
               AND m.profile_id = ?
               AND m.matcher_version IN ${SURFACED_MATCHER_VERSIONS_SQL}
        WHERE ${activePredicate(db)}
          AND (${like})
        ORDER BY COALESCE(m.match_score, -1) DESC
        LIMIT ?`,
    ).all(String(profileId), ...params, ITEM_SEARCH_CATALOG_SCAN)
  } catch (err) {
    log.warn(`[itemNeedSearch] catalog lane failed (continuing web-only): ${err?.message ?? err}`)
    return { results: [], scanned: 0, terms, refusedNoPhrase: 0, refusedByEngine: 0, liveScored: 0, error: err?.message ?? String(err) }
  }

  const results = []
  let refusedNoPhrase = 0
  let refusedByEngine = 0
  let liveScored = 0
  for (const row of rows ?? []) {
    const rowCategories = parseArrayField(row.categories)
    const needMatch = scoreNeedMatch(
      { name: row.title, description: row.description, categories: rowCategories },
      expanded,
    )
    const score = needMatch?.score ?? 0
    if (score < ITEM_NEED_MIN_SCORE) continue
    const phrase = statesEndorsingPhrase(`${row.title ?? ''} ${row.description ?? ''} ${row.keywords ?? ''}`, phrases)
    if (!phrase) { refusedNoPhrase += 1; continue }

    // A STORED verdict wins; otherwise the engine decides LIVE. A REJECT is
    // dropped either way — an item search must never surface a row the
    // canonical engine says this profile cannot receive.
    let decision = row.match_decision ?? null
    let matchScore = row.match_score ?? null
    let explanation = row.match_explanation ?? null
    let matcherVersion = row.matcher_version ?? null
    if (!decision) {
      if (!profileContext?.profile) { refusedByEngine += 1; continue }
      let live = null
      try {
        live = computeMatchDecision(profileContext, {
          ...row,
          categories: rowCategories,
          keywords: parseArrayField(row.keywords),
        })
      } catch { live = null }
      if (!live) { refusedByEngine += 1; continue }
      liveScored += 1
      decision = live.decision
      matchScore = live.score ?? null
      explanation = live.explanation ?? null
      matcherVersion = 'live-item-search'
    }
    if (String(decision).toUpperCase() === 'REJECT') { refusedByEngine += 1; continue }

    results.push({
      endorsing_phrase: phrase,
      id: row.id,
      title: row.title,
      sponsor: row.sponsor,
      description: row.description,
      url: row.application_url || row.source_url || null,
      state: row.state,
      amount_min: row.amount_min,
      amount_max: row.amount_max,
      deadline: row.deadline,
      opportunity_kind: row.opportunity_kind ?? null,
      // UNKNOWN, not FALSE, when the row has no kind. `isPointerKind(null)`
      // returns false, and publishing that as "awardable" is the same defect as
      // publishing `Number(null)` as a measured 0% confidence: a value nobody
      // measured, presented as a measurement. Prod holds catalog rows with a
      // NULL `opportunity_kind` (all six license-reinstatement rows this search
      // returns), so folding them into `awardable_count` would overstate what
      // the profile can actually receive.
      is_pointer: declaredKind(row.opportunity_kind) === null
        ? null
        : isPointerKind(row.opportunity_kind),
      match_score: matchScore,
      match_decision: decision,
      match_explanation: explanation,
      matcher_version: matcherVersion,
      need_score: score,
      matched_terms: needMatch?.matchedTerms ?? [],
      result_source: 'catalog',
      record_origin: row.record_origin ?? null,
    })
  }
  results.sort((a, b) => (b.need_score ?? 0) - (a.need_score ?? 0))
  return { results, scanned: (rows ?? []).length, terms, refusedNoPhrase, refusedByEngine, liveScored }
}

/**
 * WEB LANE — live search leads for the item.
 *
 * A LEAD IS NOT A MATCH. Leads carry `result_source: 'web_search'` and
 * `is_lead: true`, are never written to the catalog from here, and never carry
 * an `application_url` this code invented. They are `is_pointer: null` —
 * UNKNOWN, not false: nothing has classified their kind, and reporting an
 * unclassified page as "awardable" would be the `Number(null) === 0` class one
 * level up (a value nobody measured, published as a measurement).
 */
async function searchWebLane({ itemText, expanded, profileContext, variant, timeoutMs, phrases }) {
  if (!isWebDiscoveryEnabled()) {
    return { results: [], attempted: false, queries: [], raw: 0, refusedNoPhrase: 0, refusedNoFundingIntent: 0, disabled: true }
  }
  let lane
  try {
    lane = await searchNeedWebLeads({
      needText: itemText,
      expandedNeed: expanded,
      profileContext,
      variant,
      maxQueries: 5,
      perQueryCount: 6,
      timeoutMs,
    })
  } catch (err) {
    return { results: [], attempted: true, queries: [], raw: 0, refusedNoPhrase: 0, refusedNoFundingIntent: 0, error: err?.message ?? String(err) }
  }

  const results = []
  let refusedNoPhrase = 0
  let refusedNoFundingIntent = 0
  for (const lead of lane.opportunities ?? []) {
    const needMatch = scoreNeedMatch(
      { name: lead.title, description: lead.description, categories: lead.categories || [] },
      expanded,
    )
    const score = needMatch?.score ?? 0
    if (score < ITEM_NEED_MIN_SCORE) continue
    const leadText = `${lead.title ?? ''} ${lead.description ?? ''}`
    const phrase = statesEndorsingPhrase(leadText, phrases)
    if (!phrase) { refusedNoPhrase += 1; continue }
    const intent = statesFundingIntent(leadText)
    if (!intent) { refusedNoFundingIntent += 1; continue }
    results.push({
      endorsing_phrase: phrase,
      funding_intent_term: intent,
      id: lead.id ?? null,
      title: lead.title,
      sponsor: lead.sponsor ?? null,
      description: lead.description ?? null,
      url: lead.url ?? null,
      state: lead.state ?? null,
      opportunity_kind: null,
      is_pointer: null,
      need_score: score,
      matched_terms: needMatch?.matchedTerms ?? [],
      result_source: 'web_search',
      record_origin: 'web_search',
      is_lead: true,
    })
  }
  results.sort((a, b) => (b.need_score ?? 0) - (a.need_score ?? 0))
  return {
    results,
    attempted: true,
    queries: lane.debug?.queries ?? [],
    raw: lane.debug?.raw ?? 0,
    refusedNoPhrase,
    refusedNoFundingIntent,
    error: lane.debug?.error ?? null,
  }
}

/**
 * Search ONE item for ONE profile.
 *
 * @returns {Promise<Object>} an honest per-item answer, including `found: 0`.
 */
export async function searchItemNeed(db, {
  profileId,
  item,
  profileContext = null,
  variant = 'funding',
  timeoutMs = 12000,
  maxResults = ITEM_SEARCH_MAX_RESULTS,
} = {}) {
  const itemText = String(item ?? '').trim()
  if (!itemText) {
    const err = new Error('item is required')
    err.statusCode = 400
    throw err
  }

  const expanded = expandNeed(itemText)
  const phrases = buildEndorsementPhrases(itemText, expanded)
  const [catalog, web] = await Promise.all([
    searchCatalogLane(db, { profileId, itemText, expanded, phrases, profileContext }),
    searchWebLane({
      itemText,
      expanded,
      profileContext: profileContext ?? {},
      variant: variant === 'gift' ? 'gift' : 'funding',
      timeoutMs,
      phrases,
    }),
  ])

  // Dedupe web leads against catalog rows by URL — the same page found twice is
  // one source, and reporting it twice inflates the count the owner reads.
  const seen = new Set(
    catalog.results.map((r) => String(r.url ?? '').toLowerCase().replace(/\/$/, '')).filter(Boolean),
  )
  const webUnique = web.results.filter((r) => {
    const k = String(r.url ?? '').toLowerCase().replace(/\/$/, '')
    if (!k) return true
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })

  const merged = [...catalog.results, ...webUnique]
    .sort((a, b) => (b.need_score ?? 0) - (a.need_score ?? 0))
    .slice(0, Math.max(1, Math.min(Number(maxResults) || ITEM_SEARCH_MAX_RESULTS, 40)))

  // AWARDABLE vs POINTER, from the registry (`isPointerKind`), never a
  // hand-typed kind list. A row whose kind was never classified — every web
  // lead, and any catalog row with a NULL `opportunity_kind` — is counted
  // SEPARATELY as `unclassified`, never folded into either bucket: an
  // unmeasured value must not be published as a measurement.
  const awardable = merged.filter((r) => r.is_pointer === false).length
  const pointer = merged.filter((r) => r.is_pointer === true).length
  const unclassified = merged.filter((r) => r.is_pointer === null || r.is_pointer === undefined).length

  return {
    item: itemText,
    expanded: {
      canonicalNeed: expanded?.canonicalNeed ?? null,
      matchedKey: expanded?.matchedKey ?? null,
      synonyms: (expanded?.synonyms ?? []).slice(0, 10),
      programCategories: expanded?.programCategories ?? [],
    },
    endorsement_phrases: phrases,
    found: merged.length,
    awardable_count: awardable,
    pointer_count: pointer,
    unclassified_count: unclassified,
    results: merged,
    lanes: {
      catalog: {
        scanned: catalog.scanned,
        matched: catalog.results.length,
        refused_no_phrase: catalog.refusedNoPhrase ?? 0,
        refused_by_engine: catalog.refusedByEngine ?? 0,
        live_scored: catalog.liveScored ?? 0,
        like_terms: catalog.terms,
        error: catalog.error ?? null,
      },
      web: {
        attempted: web.attempted,
        disabled: web.disabled ?? false,
        queries: web.queries,
        raw_results: web.raw,
        matched: web.results.length,
        refused_no_phrase: web.refusedNoPhrase ?? 0,
        refused_no_funding_intent: web.refusedNoFundingIntent ?? 0,
        error: web.error ?? null,
      },
    },
    searched_at: new Date().toISOString(),
  }
}

/**
 * Search a LIST of items for one profile, sequentially and bounded.
 *
 * Sequential on purpose: each item fans out to five live web queries, and
 * firing a whole item list in parallel is how a shared search backend gets rate
 * limited into the 202-anti-bot state that silently zeroed item search for
 * months (documented in `itemFundingCrawler.js`'s own header).
 */
export async function searchItemNeeds(db, {
  profileId,
  items,
  profileContext = null,
  variant = 'funding',
  timeoutMs = 12000,
} = {}) {
  const requested = (Array.isArray(items) ? items : [items])
    .map((i) => String(i ?? '').trim())
    .filter(Boolean)
  const unique = [...new Map(requested.map((i) => [norm(i), i])).values()]
  const searched = unique.slice(0, ITEM_SEARCH_MAX_ITEMS)

  const results = []
  for (const item of searched) {
    try {
      results.push(await searchItemNeed(db, { profileId, item, profileContext, variant, timeoutMs }))
    } catch (err) {
      results.push({
        item,
        found: 0,
        awardable_count: 0,
        pointer_count: 0,
        unclassified_count: 0,
        results: [],
        error: err?.message ?? String(err),
        searched_at: new Date().toISOString(),
      })
    }
  }

  return {
    profile_id: String(profileId),
    requested_count: unique.length,
    searched_count: searched.length,
    truncated: Math.max(0, unique.length - searched.length),
    total_found: results.reduce((n, r) => n + (r.found ?? 0), 0),
    total_awardable: results.reduce((n, r) => n + (r.awardable_count ?? 0), 0),
    total_pointer: results.reduce((n, r) => n + (r.pointer_count ?? 0), 0),
    total_unclassified: results.reduce((n, r) => n + (r.unclassified_count ?? 0), 0),
    items: results,
  }
}

export default {
  searchItemNeed,
  searchItemNeeds,
  buildItemLikeTerms,
  buildEndorsementPhrases,
  statesEndorsingPhrase,
  statesFundingIntent,
  FUNDING_INTENT_TERMS,
  ITEM_NEED_MIN_SCORE,
}
