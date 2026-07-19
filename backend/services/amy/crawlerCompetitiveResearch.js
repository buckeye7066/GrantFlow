/**
 * crawlerCompetitiveResearch.js — Amy's "how do OTHER crawlers do it?" goal.
 *
 * OWNER DIRECTIVE (2026-07-14): "search other GitHub repos and grant-writing
 * programs, codebases, etc. and see how their crawlers work. If it is more
 * optimal than ours, tell me about it and suggest how to implement the change
 * to best meet the needs of the profile with real relatable funding sources.
 * Have it be a part of the morning email sent by Anya."
 *
 * WHAT IT DOES
 *   1. Runs a BOUNDED web-search session over a curated set of research queries
 *      about how open-source grant-discovery / funding-search crawlers work
 *      (GitHub repos, grant-writing tools, scraping pipelines, funding APIs).
 *   2. Filters the hits to real, actionable engineering sources (GitHub / docs /
 *      engineering blogs — search-engine / social / placeholder noise dropped via
 *      the canonical urlRules, aggregator listicles dropped).
 *   3. Asks the LLM to compare each candidate technique against GrantFlow's OWN
 *      current crawler approach and return, as JSON, only the techniques that are
 *      plausibly MORE OPTIMAL — each with a concrete implementation suggestion
 *      tied to surfacing real, relatable funding for the profile archetypes.
 *   4. Persists the result to system_kv `amy_crawler_research` (runs ring +
 *      latest snapshot) so Anya's 09:00 owner email can read it.
 *
 * DOCTRINE — this goal NEVER changes code or the catalog. Like the web-parity
 * gap queue, its output is ADVISORY candidate evidence for the owner to judge.
 * The morning email surfaces it; a human decides what to implement.
 *
 * Scheduling: a THROTTLED, bounded step in runNightlyMaintenanceSweep. The LLM
 * pass is not cheap and competitor techniques do not change nightly, so the run
 * self-skips unless the last run is older than MIN_INTERVAL_MS (default 3 days).
 * The morning email always shows the latest persisted snapshot regardless.
 *
 * Gate: AMY_CRAWLER_RESEARCH (enabled by default; set =false to disable).
 * Search + LLM are INJECTED so tests run fully offline.
 */

import { searchWeb as defaultSearchWeb } from '../shared/webSearchEngine.js'
import { invokeJsonWithFallback, getOpenAIOptional } from '../../utils/aiProviders.js'
import {
  isSearchEngineUrl,
  isPlaceholderUrl,
  isNonActionableUrl,
  extractHostname,
} from '../../config/urlRules.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('services:amy:crawlerResearch')

/** system_kv key holding the research history + latest snapshot. */
export const KV_KEY = 'amy_crawler_research'

/** Bounded research budget — a focused literature scan, not a crawl. */
export const MAX_QUERIES = 6
export const MAX_RESULTS_PER_QUERY = 8
/** Candidate techniques handed to the LLM (post-filter, deduped by domain+title). */
export const MAX_CANDIDATES = 24
/** Findings kept in the persisted snapshot / shown to the owner. */
export const MAX_FINDINGS = 6
/** History ring size. */
export const MAX_RUN_HISTORY = 12
/** Do not re-run the LLM pass more often than this (competitor tech is slow-moving). */
export const MIN_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000

/**
 * The research questions. Deliberately about crawler / discovery ENGINEERING,
 * not about specific grants — the goal is technique transfer. Kept as a frozen
 * constant so runs are deterministic and testable.
 */
export const RESEARCH_QUERIES = Object.freeze([
  'open source grant discovery crawler github',
  'grants.gov api scraper funding opportunities open source',
  'nonprofit grant search engine architecture how it works',
  'foundation 990 grant data pipeline github',
  'grant matching relevance ranking algorithm open source',
  'scholarship aggregator web scraping techniques',
])

/**
 * A short, honest description of GrantFlow's CURRENT crawler approach, given to
 * the LLM as the baseline to compare candidates against. Keep this accurate: a
 * comparison is only useful if the baseline is real. Update it when the crawler
 * architecture materially changes.
 */
export const CURRENT_APPROACH = [
  'GrantFlow discovers funding via crawler-os: structured adapters for official feeds',
  '(grants.gov, sam.gov, SBIR, NIH RePORTER, USASpending, Federal Register, state portals),',
  'PLUS an open-web lane (SearXNG/Brave search -> LLM extraction of grant pages).',
  'Queries are thesis-driven per profile (buildWebQueries from needs + geography +',
  'applicant type). Extracted opportunities are deduped by a canonical key, scored',
  'per-profile by a data-point matchEngine (matched fields / total x eligibility x geo',
  'gates), and award dollar amounts are extracted conservatively from the funder\'s own',
  'page (precision over recall). Weak spots we know about: hyperlocal/community funder',
  'recall, per-award amount coverage (~18% of catalog), and relevance precision',
  '(false positives) on ambiguous profiles.',
].join(' ')

/** Domains that are listicle/aggregator noise for ENGINEERING research (not code). */
const RESEARCH_NOISE_DOMAINS = Object.freeze(new Set([
  'grantwatch.com',
  'instrumentl.com',
  'grantstation.com',
  'pinterest.com',
  'quora.com',
  'reddit.com',
  'facebook.com',
  'youtube.com',
]))

/** Text signal that a hit is about crawler / discovery / data-pipeline engineering. */
const TECH_SIGNAL_RE =
  /\b(crawl(?:er|ing)?|scrap(?:e|er|ing)|spider|pipeline|api|dataset|etl|ingest(?:ion)?|index(?:ing)?|ranking|embedding|repository|repo|github|open[- ]source|algorithm|architecture)\b/i

export function isCrawlerResearchEnabled() {
  return String(process.env.AMY_CRAWLER_RESEARCH ?? 'true').toLowerCase() !== 'false'
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers — filter + dedup + summarize
// ─────────────────────────────────────────────────────────────────────────────

/** Normalized URL identity (protocol/www/hash/trailing-slash insensitive). */
export function normalizeUrlKey(url) {
  const s = String(url || '').trim().toLowerCase()
  if (!/^https?:\/\//.test(s)) return ''
  return s.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/#.*$/, '').replace(/\/+$/, '')
}

/**
 * "Real engineering source" filter for a web hit ({url,title,snippet}):
 *   - http(s), NOT a search-engine / placeholder / non-actionable URL,
 *   - NOT a known research-noise domain,
 *   - carries a crawler/discovery/engineering signal in title/snippet/url.
 * Pure; exported for tests.
 */
export function isResearchHit(hit) {
  const url = String(hit?.url || '').trim()
  if (!/^https?:\/\//i.test(url)) return false
  if (isSearchEngineUrl(url) || isPlaceholderUrl(url) || isNonActionableUrl(url)) return false
  const domain = extractHostname(url)
  if (!domain || RESEARCH_NOISE_DOMAINS.has(domain)) return false
  const text = `${hit?.title ?? ''} ${hit?.snippet ?? ''} ${url}`
  return TECH_SIGNAL_RE.test(text)
}

/**
 * Collapse raw web hits to a deduped candidate list for the LLM: filtered,
 * deduped by normalized URL then by (domain|lowercased-title), capped. GitHub
 * repository hits are floated to the front (most directly reusable). Pure.
 */
export function buildCandidates(hits, { max = MAX_CANDIDATES } = {}) {
  const seenUrl = new Set()
  const seenIdentity = new Set()
  const out = []
  for (const hit of Array.isArray(hits) ? hits : []) {
    if (!isResearchHit(hit)) continue
    const urlKey = normalizeUrlKey(hit.url)
    if (!urlKey || seenUrl.has(urlKey)) continue
    const domain = extractHostname(hit.url) || ''
    const title = String(hit.title || '').trim().slice(0, 160)
    const identity = `${domain}|${title.toLowerCase()}`
    if (seenIdentity.has(identity)) continue
    seenUrl.add(urlKey)
    seenIdentity.add(identity)
    out.push({
      url: String(hit.url).trim(),
      title,
      snippet: String(hit.snippet || '').trim().slice(0, 320),
      domain,
      is_repo: /github\.com|gitlab\.com|sourceforge\.net|codeberg\.org|bitbucket\.org/.test(domain),
    })
  }
  // GitHub/code repos first (most directly reusable technique transfer).
  out.sort((a, b) => Number(b.is_repo) - Number(a.is_repo))
  return out.slice(0, max)
}

/** Clamp/validate a single LLM finding into the persisted shape. Pure. */
function normalizeFinding(f, candidateByUrl) {
  if (!f || typeof f !== 'object') return null
  const url = String(f.url || '').trim()
  const cand = candidateByUrl.get(normalizeUrlKey(url))
  const source_title = String(f.source_title || f.title || cand?.title || '').trim().slice(0, 160)
  const technique = String(f.technique || '').trim().slice(0, 240)
  if (!technique) return null
  const effortRaw = String(f.effort || '').trim().toLowerCase()
  const effort = ['low', 'medium', 'high'].includes(effortRaw) ? effortRaw : 'medium'
  const archetypes = Array.isArray(f.archetypes)
    ? f.archetypes.map((a) => String(a || '').trim()).filter(Boolean).slice(0, 6)
    : []
  return {
    source_title: source_title || cand?.domain || 'unknown source',
    url: url || cand?.url || null,
    domain: cand?.domain || extractHostname(url) || null,
    technique,
    more_optimal: f.more_optimal === true,
    why: String(f.why || '').trim().slice(0, 400),
    suggestion: String(f.suggestion || '').trim().slice(0, 500),
    archetypes,
    effort,
  }
}

/**
 * Summarize the persisted research store for the owner email: a headline, the
 * "more optimal" findings (each a technique + concrete suggestion), and a note
 * when nothing beat GrantFlow's current approach. Pure; exported for tests.
 *
 * @param {{latest?:object|null}} store the system_kv `amy_crawler_research` store
 * @returns {{headline:string, findings:string[], allClear:boolean, generatedAt:string|null}|null}
 */
export function summarizeCrawlerResearch(store) {
  const latest = store?.latest
  if (!latest || !Array.isArray(latest.findings)) return null
  const optimal = latest.findings.filter((f) => f?.more_optimal)
  const scanned = Number(latest.candidates_scanned) || 0
  const allClear = optimal.length === 0

  const headline = allClear
    ? `Scanned ${scanned} competitor crawler technique(s) — none beat GrantFlow's current approach this run.`
    : `${optimal.length} competitor technique(s) look MORE optimal than ours (scanned ${scanned}). Candidates only — nothing changed.`

  const findings = optimal.slice(0, MAX_FINDINGS).map((f) => {
    const who = f.source_title || f.domain || 'source'
    const arche = f.archetypes?.length ? ` [${f.archetypes.slice(0, 3).join(', ')}]` : ''
    const effort = f.effort ? ` (effort: ${f.effort})` : ''
    const suggestion = f.suggestion ? ` → Suggested: ${f.suggestion}` : ''
    return `${who}: ${f.technique}${effort}${arche}${suggestion}`
  })

  return { headline, findings, allClear, generatedAt: latest.generated_at || null }
}

// ─────────────────────────────────────────────────────────────────────────────
// Persistence (system_kv; UPDATE-then-INSERT — shim-safe)
// ─────────────────────────────────────────────────────────────────────────────

async function ensureKv(db) {
  await db.prepare('CREATE TABLE IF NOT EXISTS system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)').run()
}

async function kvSet(db, key, obj, at) {
  await ensureKv(db)
  const now = at || new Date().toISOString()
  const value = JSON.stringify(obj)
  const res = await db.prepare('UPDATE system_kv SET value = ?, updated_at = ? WHERE key = ?').run(value, now, key)
  if (!Number(res?.changes ?? res?.rowCount ?? 0)) {
    await db.prepare('INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)').run(key, value, now)
  }
}

async function kvGetJson(db, key) {
  try {
    const row = await db.prepare('SELECT value FROM system_kv WHERE key = ?').get(key)
    return row?.value ? JSON.parse(row.value) : null
  } catch {
    return null
  }
}

/** Read the persisted research store (Anya digest / admin). */
export async function readCrawlerResearch(db) {
  if (!db?.prepare) return null
  return kvGetJson(db, KV_KEY)
}

// ─────────────────────────────────────────────────────────────────────────────
// Default LLM analysis (injectable)
// ─────────────────────────────────────────────────────────────────────────────

const ANALYSIS_SYSTEM =
  'You are a senior search/crawler engineer auditing a grant-discovery product. ' +
  'You are given the product\'s CURRENT crawler approach and a list of competitor / ' +
  'open-source funding-crawler sources found on the web. Identify ONLY techniques that ' +
  'are plausibly MORE OPTIMAL than the current approach for surfacing real, relatable ' +
  'funding to end-user profiles. Be skeptical: if a source does not clearly beat the ' +
  'current approach, do not include it. Never invent a source or URL not in the input.'

function buildAnalysisPrompt(candidates) {
  const lines = candidates.map(
    (c, i) => `${i + 1}. ${c.is_repo ? '[REPO] ' : ''}${c.title} — ${c.domain}\n   url: ${c.url}\n   ${c.snippet}`,
  )
  return [
    'CURRENT APPROACH:',
    CURRENT_APPROACH,
    '',
    'PROFILE ARCHETYPES we serve (tie suggestions to these where relevant):',
    'high_school_student, college_student, graduate_student, homeschool_family, ' +
      'individual_assistance, cancer_patient, veteran, small_business, nonprofit_org, disability.',
    '',
    'COMPETITOR / OPEN-SOURCE SOURCES FOUND:',
    ...lines,
    '',
    'Return JSON of this exact shape (no prose):',
    '{',
    '  "overall": "2-3 sentence synthesis of what, if anything, we should steal",',
    '  "findings": [',
    '    {',
    '      "url": "<one of the urls above>",',
    '      "source_title": "<short name>",',
    '      "technique": "<the specific technique they use>",',
    '      "more_optimal": true,',
    '      "why": "<why it beats our current approach>",',
    '      "suggestion": "<concrete implementation change in GrantFlow terms>",',
    '      "archetypes": ["<archetype it most helps>"],',
    '      "effort": "low|medium|high"',
    '    }',
    '  ]',
    '}',
    'Only include findings where more_optimal is genuinely true. Empty findings array is a valid, honest answer.',
  ].join('\n')
}

/**
 * Default analyzer: OpenAI→Anthropic JSON fallback via the shared provider
 * helper. Returns { overall, findings } or null on failure. Injectable.
 */
async function defaultAnalyze(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return { overall: '', findings: [] }
  const res = await invokeJsonWithFallback({
    openai: getOpenAIOptional(),
    system: ANALYSIS_SYSTEM,
    prompt: buildAnalysisPrompt(candidates),
    temperature: 0.2,
    maxTokens: 1600,
  })
  if (!res?.ok || !res.json) return null
  return {
    overall: String(res.json.overall || '').trim().slice(0, 600),
    findings: Array.isArray(res.json.findings) ? res.json.findings : [],
    provider: res.provider,
  }
}

async function defaultEmitTelemetry(db, event) {
  try {
    const { insertActivityEvent } = await import('../agentTelemetry/agentTelemetryStore.js')
    await insertActivityEvent(db, event)
  } catch {
    /* telemetry is best-effort */
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The research run
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run Amy's competitive crawler research.
 *
 * @param {object} db
 * @param {object} [opts]
 * @param {Function} [opts.searchWeb]   injectable (query,{count}) → [{url,title,snippet}]
 * @param {Function} [opts.analyze]     injectable (candidates) → {overall,findings}|null
 * @param {Function} [opts.emitTelemetry]
 * @param {boolean}  [opts.force=false] bypass the MIN_INTERVAL_MS throttle
 * @param {boolean}  [opts.persist=true]
 * @param {Date}     [opts.now]
 * @returns {Promise<object>} run summary { ran, reason?, findings, candidates_scanned, ... }
 */
export async function runCrawlerCompetitiveResearch(db, {
  searchWeb = defaultSearchWeb,
  analyze = defaultAnalyze,
  emitTelemetry = defaultEmitTelemetry,
  force = false,
  persist = true,
  now = new Date(),
} = {}) {
  if (!isCrawlerResearchEnabled()) return { ran: false, reason: 'disabled' }
  if (!db?.prepare) return { ran: false, reason: 'no_db' }
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime()

  // Throttle: competitor techniques don't change nightly, and the LLM pass costs.
  const prior = (await readCrawlerResearch(db)) || {}
  if (!force && prior?.latest?.generated_at) {
    const age = nowMs - new Date(prior.latest.generated_at).getTime()
    if (Number.isFinite(age) && age >= 0 && age < MIN_INTERVAL_MS) {
      return { ran: false, reason: 'throttled', next_eligible_in_ms: MIN_INTERVAL_MS - age }
    }
  }

  // 1) Bounded web-search session over the research queries.
  const hits = []
  const seen = new Set()
  let searchErrors = 0
  for (const q of RESEARCH_QUERIES.slice(0, MAX_QUERIES)) {
    let results = []
    try {
      results = await searchWeb(q, { count: MAX_RESULTS_PER_QUERY })
    } catch (err) {
      searchErrors += 1
      log.warn('research web search failed (non-fatal)', { query: q, error: err?.message })
      results = []
    }
    for (const h of (Array.isArray(results) ? results : []).slice(0, MAX_RESULTS_PER_QUERY)) {
      const key = normalizeUrlKey(h?.url)
      if (!key || seen.has(key)) continue
      seen.add(key)
      hits.push(h)
    }
  }

  const candidates = buildCandidates(hits)
  const generatedAt = new Date(nowMs).toISOString()

  if (candidates.length === 0) {
    // Honest: nothing to analyze (search outage or all-noise). Do not persist a
    // hollow snapshot that would read as "we researched and found nothing".
    const result = { ran: true, generated_at: generatedAt, candidates_scanned: 0, findings: [], overall: '', reason: 'no_candidates', search_errors: searchErrors }
    await emitTelemetry(db, {
      agent_name: 'amy',
      event_type: 'amy.crawler_research',
      status: searchErrors >= MAX_QUERIES ? 'failed' : 'succeeded',
      severity: 'info',
      title: 'Amy competitive crawler research: 0 candidate sources found',
      entity_type: 'crawler_research',
      entity_id: generatedAt,
      details_json: { search_errors: searchErrors },
    })
    return result
  }

  // 2) LLM comparison against GrantFlow's current approach.
  let analysis = null
  try {
    analysis = await analyze(candidates)
  } catch (err) {
    log.warn('research analysis failed (non-fatal)', { error: err?.message })
  }
  if (!analysis) {
    return { ran: true, generated_at: generatedAt, candidates_scanned: candidates.length, findings: [], overall: '', reason: 'analysis_failed', search_errors: searchErrors }
  }

  const candidateByUrl = new Map(candidates.map((c) => [normalizeUrlKey(c.url), c]))
  const findings = (Array.isArray(analysis.findings) ? analysis.findings : [])
    .map((f) => normalizeFinding(f, candidateByUrl))
    .filter(Boolean)
    .slice(0, MAX_FINDINGS)
  const optimalCount = findings.filter((f) => f.more_optimal).length

  const result = {
    ran: true,
    generated_at: generatedAt,
    candidates_scanned: candidates.length,
    overall: String(analysis.overall || '').slice(0, 600),
    findings,
    optimal_count: optimalCount,
    search_errors: searchErrors,
    provider: analysis.provider ?? null,
  }

  if (persist) {
    try {
      const runs = Array.isArray(prior.runs) ? prior.runs : []
      runs.push({ generated_at: generatedAt, candidates_scanned: candidates.length, optimal_count: optimalCount })
      const store = {
        generated_at: generatedAt,
        runs: runs.slice(-MAX_RUN_HISTORY),
        latest: {
          generated_at: generatedAt,
          candidates_scanned: candidates.length,
          overall: result.overall,
          findings,
        },
      }
      await kvSet(db, KV_KEY, store, generatedAt)
    } catch (err) {
      log.warn('research persist failed (result still returned)', { error: err?.message })
    }
  }

  await emitTelemetry(db, {
    agent_name: 'amy',
    event_type: 'amy.crawler_research',
    status: 'succeeded',
    severity: 'info',
    title: optimalCount > 0
      ? `Amy competitive crawler research: ${optimalCount} technique(s) may beat ours (${candidates.length} scanned)`
      : `Amy competitive crawler research: none beat our approach (${candidates.length} scanned)`,
    metric_key: 'optimal_findings',
    metric_value: optimalCount,
    entity_type: 'crawler_research',
    entity_id: generatedAt,
    details_json: { candidates_scanned: candidates.length, optimal_count: optimalCount, findings: findings.map((f) => ({ source: f.source_title, technique: f.technique })) },
  })

  return result
}

export default {
  KV_KEY,
  RESEARCH_QUERIES,
  CURRENT_APPROACH,
  MAX_QUERIES,
  MAX_RESULTS_PER_QUERY,
  MAX_CANDIDATES,
  MAX_FINDINGS,
  MIN_INTERVAL_MS,
  isCrawlerResearchEnabled,
  normalizeUrlKey,
  isResearchHit,
  buildCandidates,
  summarizeCrawlerResearch,
  readCrawlerResearch,
  runCrawlerCompetitiveResearch,
}
