/**
 * Brave + LLM scholarship/aid discovery for INDIVIDUAL profiles.
 *
 * Why: the crawler-os registry has no real specific-opportunity source for the
 * long tail of individual funding (local/private scholarships, aid funds) — they
 * have no API and live on the open web. The 2026-06-23 audit found individuals
 * got 0 matches >=75 (only directory pointers). This is the "Brave + LLM
 * extraction" half of the fix (CareerOneStop is the structured half):
 *
 *   1. profile -> scholarship-oriented web queries
 *   2. Brave web search (webSearchEngine; gated on BRAVE_SEARCH_API_KEY)
 *   3. fetch the top result pages -> text
 *   4. LLM-extract REAL, specific scholarships (title/sponsor/deadline/amount/
 *      eligibility/apply_url) — empty when a page has none (never fabricates)
 *   5. upsert to the global funding_opportunities catalog (deduped) +
 *      persist a per-profile match row (matcher_version='web-llm', so the
 *      crawler-os run's match reconcile never wipes it).
 *
 * Honest + bounded: gated on BRAVE_SEARCH_API_KEY + ANTHROPIC_API_KEY (returns a
 * skipped result otherwise), time/count-capped, and failure-tolerant — a bad
 * page or a non-JSON model reply is skipped, never faked.
 */

import { searchWeb } from '../shared/webSearchEngine.js'
import { buildLocalFundingQueries } from '../shared/liveWebSearch.js'
import { htmlToText } from '../yana/yanaContactEnrichment.js'
import { upsertFundingOpportunity } from '../opportunityInserter.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('service:scholarshipWebDiscovery')

const WEB_LLM_MATCHER_VERSION = 'web-llm'
const EXTRACT_MODEL = process.env.SCHOLARSHIP_EXTRACT_MODEL || 'claude-sonnet-4-6'

export function isScholarshipWebDiscoveryEnabled() {
  return Boolean(process.env.BRAVE_SEARCH_API_KEY) && Boolean(process.env.ANTHROPIC_API_KEY)
}

/** Fetch a page and return readable text (bounded), or '' on any failure. */
async function fetchPageText(url, { timeoutMs = 8000, maxChars = 6000 } = {}) {
  if (typeof fetch !== 'function') return ''
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'GrantFlowBot/1.0 (+funding discovery)' },
    })
    if (!resp.ok) return ''
    const html = await resp.text()
    return htmlToText(html, maxChars)
  } catch {
    return ''
  } finally {
    clearTimeout(t)
  }
}

/**
 * Ask the model to extract REAL scholarships/aid from one page's text. Returns
 * an array (possibly empty). Never throws — a parse failure yields [].
 */
async function extractScholarshipsFromText({ text, pageUrl, profileSummary }) {
  if (!text || text.length < 80) return []
  let Anthropic
  try {
    Anthropic = (await import('@anthropic-ai/sdk')).default
  } catch {
    return []
  }
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const prompt = `You extract REAL, specific funding opportunities (scholarships, grants, or aid funds an INDIVIDUAL can apply to) from a web page's text. Return STRICT JSON only.

Applicant profile (for relevance, do NOT invent eligibility): ${profileSummary}

Page URL: ${pageUrl}
Page text (truncated):
"""
${text}
"""

Return a JSON object: {"opportunities":[{"title","sponsor","deadline","amount_max","eligibility_summary","apply_url"}]}.
Rules:
- ONLY include a specific, named opportunity an individual can actually apply to. If the page is a list/blog/directory with no specific applyable award, return {"opportunities":[]}.
- Never invent a title, sponsor, deadline, amount, or URL. Use null for anything not stated. apply_url must be an absolute URL present on/derived from the page (else null).
- deadline: ISO YYYY-MM-DD if a date is stated, else null. amount_max: a number (USD) if stated, else null.
- Max 5 opportunities. JSON only, no prose.`

  try {
    const resp = await client.messages.create({
      model: EXTRACT_MODEL,
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    })
    const raw = resp?.content?.[0]?.text ?? ''
    const jsonStr = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)
    const parsed = JSON.parse(jsonStr)
    const list = Array.isArray(parsed?.opportunities) ? parsed.opportunities : []
    return list
      .filter((o) => o && typeof o.title === 'string' && o.title.trim())
      .slice(0, 5)
      .map((o) => ({
        title: String(o.title).slice(0, 400),
        sponsor: o.sponsor ? String(o.sponsor).slice(0, 200) : null,
        deadline: typeof o.deadline === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.deadline) ? o.deadline : null,
        amount_max: Number.isFinite(Number(o.amount_max)) && Number(o.amount_max) > 0 ? Number(o.amount_max) : null,
        eligibility_summary: o.eligibility_summary ? String(o.eligibility_summary).slice(0, 600) : null,
        apply_url:
          typeof o.apply_url === 'string' && /^https?:\/\//i.test(o.apply_url) ? o.apply_url : pageUrl,
      }))
  } catch (err) {
    log.warn(`extract failed for ${pageUrl}: ${err?.message || err}`)
    return []
  }
}

/**
 * Discover individual scholarships/aid for a profile via Brave + LLM and persist
 * them. Caller passes the loaded profileContext (signals.location etc.) and the
 * crawler-os thesis (for matching). Returns a summary.
 *
 * @param {object} db
 * @param {object} args
 * @param {object} args.profileContext  loadProfileContext output
 * @param {object} args.thesis          buildThesis output (for the match decision)
 * @param {Function} [args.computeMatchDecision]  injected matcher (crawler-os)
 * @param {number} [args.maxPages=5]     pages to fetch+extract (cost bound)
 * @param {number} [args.timeoutMs=22000]
 */
export async function discoverScholarshipsViaWeb(db, {
  profileContext,
  thesis,
  computeMatchDecision = null,
  maxPages = 5,
  timeoutMs = 22000,
} = {}) {
  if (!db) throw new Error('discoverScholarshipsViaWeb: db required')
  if (!isScholarshipWebDiscoveryEnabled()) {
    return { ok: false, skipped: true, reason: 'missing BRAVE_SEARCH_API_KEY or ANTHROPIC_API_KEY', inserted: 0, matched: 0 }
  }
  const profileId = profileContext?.profile?.id ?? thesis?.profile_id ?? null
  if (!profileId) return { ok: false, reason: 'no_profile_id', inserted: 0, matched: 0 }

  const deadline = Date.now() + timeoutMs
  // Scholarship-biased queries from the full profile (reuses the local-funding
  // query builder; it already emits "<need> scholarship <place>" for students).
  const queries = buildLocalFundingQueries(profileContext, 6)
  if (queries.length === 0) return { ok: true, inserted: 0, matched: 0, reason: 'no_queries' }

  // 1) Brave search → dedup leads by URL.
  const byUrl = new Map()
  for (const q of queries) {
    if (Date.now() > deadline) break
    const results = await searchWeb(q, { count: 6, timeoutMs: Math.min(deadline - Date.now(), 8000) }).catch(() => [])
    for (const r of results) {
      const key = String(r.url || '').toLowerCase().replace(/\/$/, '')
      if (key && !byUrl.has(key)) byUrl.set(key, r)
    }
  }
  const leads = [...byUrl.values()].slice(0, maxPages)

  // 2) fetch + LLM-extract each lead page.
  const profileSummary = [
    `type: ${(thesis?.applicant_types || []).join('/') || 'individual'}`,
    `needs: ${(thesis?.needs || []).join(', ') || 'general'}`,
    `location: ${[profileContext?.signals?.location?.city, profileContext?.signals?.location?.state].filter(Boolean).join(', ') || 'US'}`,
  ].join('; ')

  const extracted = []
  for (const lead of leads) {
    if (Date.now() > deadline) break
    const text = await fetchPageText(lead.url, { timeoutMs: Math.min(deadline - Date.now(), 8000) })
    const opps = await extractScholarshipsFromText({ text, pageUrl: lead.url, profileSummary })
    for (const o of opps) extracted.push(o)
  }

  // 3) upsert to catalog + persist a per-profile match (web-llm version).
  let inserted = 0
  let matched = 0
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  for (const o of extracted) {
    try {
      const opportunity = {
        title: o.title,
        sponsor: o.sponsor || 'Scholarship sponsor',
        description: o.eligibility_summary || `Scholarship discovered via web search.`,
        source: 'web_llm',
        record_origin: 'web_llm',
        source_url: o.apply_url,
        application_url: o.apply_url,
        opportunity_type: 'scholarship',
        is_national: true,
        deadline: o.deadline,
        amount_max: o.amount_max,
        // Leads are unverified: the verification gate keeps them low-trust and
        // the decision engine won't ACCEPT until verified.
        eligibility_status: 'pending',
      }
      const out = await upsertFundingOpportunity(db, opportunity)
      const oppId = out?.id || out?.opportunity?.id || null
      if (out?.inserted) inserted += 1
      // 4) per-profile match (web-llm matcher_version is NOT wiped by the
      //    crawler-os match reconcile, so these survive subsequent OS runs).
      if (oppId && computeMatchDecision && thesis) {
        const osOpp = {
          id: oppId,
          kind: 'SCHOLARSHIP',
          title: o.title,
          need_categories: ['education'],
          applicant_types: thesis.applicant_types || ['individual'],
          geography: { national: true, states: [] },
          funding: { amount_max: o.amount_max ?? undefined },
          apply_url: o.apply_url,
          trust_tier: 'unknown',
          reality_status: 'link_unverified',
          deadline: o.deadline,
        }
        const decision = computeMatchDecision(osOpp, thesis)
        await db.prepare(
          `INSERT INTO profile_opportunity_matches
             (profile_id, opportunity_id, match_score, match_decision, match_explanation, matcher_version, computed_at, updated_at, evaluated_at)
           VALUES (?, ?, ?, ?, ?, ?, ${nowFn}, ${nowFn}, ${nowFn})
           ON CONFLICT (profile_id, opportunity_id) DO UPDATE SET
             match_score = excluded.match_score, match_decision = excluded.match_decision,
             match_explanation = excluded.match_explanation, matcher_version = excluded.matcher_version,
             updated_at = ${nowFn}`,
        ).run(
          String(profileId), String(oppId), Math.round(decision.match_score || 0),
          decision.decision || 'review', (decision.match_explain?.why || '').slice(0, 500),
          WEB_LLM_MATCHER_VERSION,
        )
        matched += 1
      }
    } catch (err) {
      log.warn(`upsert/match failed for "${o.title}": ${err?.message || err}`)
    }
  }

  log.info(`[scholarshipWebDiscovery] profile=${profileId} queries=${queries.length} leads=${leads.length} extracted=${extracted.length} inserted=${inserted} matched=${matched}`)
  return { ok: true, inserted, matched, extracted: extracted.length, leads: leads.length, queries: queries.length }
}

export default { discoverScholarshipsViaWeb, isScholarshipWebDiscoveryEnabled, WEB_LLM_MATCHER_VERSION }
