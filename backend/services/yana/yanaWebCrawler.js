/**
 * yanaWebCrawler.js — broad-web client (organization) discovery for Yana.
 *
 * Feeds Yana's existing lead funnel (yanaLeadDiscovery) by discovering REAL
 * prospective-client ORGANIZATIONS from vetted public sources and upserting them
 * into the `organizations` table. The funnel then scores / qualifies / caps them
 * exactly as it does for hand-entered orgs — no funnel changes needed.
 *
 * DELIBERATE SCOPE / SAFETY POSTURE
 *   - ORGANIZATIONS ONLY. This never harvests personal contact data of private
 *     individuals (students, families, etc.). Cold-emailing scraped personal
 *     data would violate CAN-SPAM / GDPR / CCPA and basic decency. Individuals
 *     enter GrantFlow by signing up, not by being scraped.
 *   - DEFAULT OFF, ZERO DEFAULT SOURCES. YANA_WEB_CRAWLER_ENABLED is false by
 *     default and no source is registered unless an operator names a vetted one
 *     in YANA_WEB_SOURCES. The engine is inert until then.
 *   - POLITE. Every source is checked against robots.txt (robotsPolicy) before
 *     fetching, and a per-domain delay throttles requests.
 *   - REAL ONLY. Candidates with a website are liveness-verified; obvious junk /
 *     placeholders are rejected; everything is deduped against existing orgs.
 *   - INJECTABLE. fetchImpl / headCheck / robotsCheck / delay are all injectable
 *     so this is fully testable offline and never hits the network by default.
 */

import crypto from 'node:crypto'
import { getWithRetry, headForVerification } from '../crawlers/httpClient.js'
import { isUrlAllowed } from '../crawlers/robotsPolicy.js'
import { enrichOrgContact } from '../crawlers/orgContactEnrichment.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('yana-web-crawler')

function readBool(env, name, fallback) {
  const raw = env?.[name]
  if (raw === null || raw === undefined || raw === '') return fallback
  return /^(1|true|yes|on)$/i.test(String(raw).trim())
}

/** Crawler config — OFF by default, no sources by default. */
export function getYanaCrawlerConfig(env = process.env) {
  const sources = String(env?.YANA_WEB_SOURCES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return {
    enabled: readBool(env, 'YANA_WEB_CRAWLER_ENABLED', false),
    sources,
    maxPerRun: Math.max(1, Number(env?.YANA_WEB_MAX_PER_RUN || 200)),
    perDomainDelayMs: Math.max(0, Number(env?.YANA_WEB_DOMAIN_DELAY_MS || 1000)),
    // Enrich a website-only org with its published contact email so the funnel
    // can qualify it (email is a required gate). On by default when crawling.
    enrichEmails: readBool(env, 'YANA_WEB_ENRICH_EMAILS', true),
    userAgent: 'GrantFlow Crawler/1.0 (+contact: support@grantflow.app)',
  }
}

// ── Source-adapter registry ────────────────────────────────────────────────
// An adapter = { name, baseUrl?, fetchCandidates({ fetchImpl, limit, logger }) }
// returning org candidates in the funnel shape (name/email/website/mission/...).

const sources = new Map()

export function registerWebSource(adapter) {
  if (!adapter || typeof adapter.name !== 'string' || typeof adapter.fetchCandidates !== 'function') {
    throw new Error('registerWebSource: adapter must be { name, fetchCandidates() }')
  }
  sources.set(adapter.name, adapter)
}
export function getWebSource(name) { return sources.get(name) || null }
export function listWebSources() { return [...sources.keys()] }
export function _clearWebSources() { sources.clear() }

// ── Pure helpers ────────────────────────────────────────────────────────────

export function normalizeWebsite(raw) {
  const s = String(raw || '').trim()
  if (!s) return null
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`
  try {
    const u = new URL(withScheme)
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/$/, '')}`.toLowerCase()
  } catch {
    return null
  }
}

/** Stable dedupe key: website host → ein → email → name+state. */
export function dedupeKey(org = {}) {
  const site = normalizeWebsite(org.website || org.website_url)
  if (site) { try { return `web:${new URL(site).host}` } catch { /* fall through */ } }
  if (org.ein && String(org.ein).trim()) return `ein:${String(org.ein).replace(/\D/g, '')}`
  if (org.email && String(org.email).trim()) return `email:${String(org.email).trim().toLowerCase()}`
  const name = String(org.name || org.organization_name || '').trim().toLowerCase()
  const state = String(org.state || '').trim().toLowerCase()
  return name ? `name:${name}|${state}` : null
}

const PLACEHOLDER_RX = /\b(lorem|ipsum|example|test\s*org|placeholder|sample|n\/a|tbd|unknown)\b/i

/** Reject obvious junk before any network verification. */
export function isJunkOrg(org = {}) {
  const name = String(org.name || org.organization_name || '').trim()
  if (name.length < 3) return true
  if (PLACEHOLDER_RX.test(name)) return true
  if (!dedupeKey(org)) return true
  return false
}

// ── Default network impls (injectable) ──────────────────────────────────────

async function defaultFetchImpl(url, { responseType = 'json', timeoutMs = 10_000 } = {}) {
  try {
    const res = await getWithRetry(url, { responseType: responseType === 'json' ? 'json' : 'text', timeout: timeoutMs })
    const ok = res.status >= 200 && res.status < 300
    return { ok, status: res.status, json: responseType === 'json' ? res.data : undefined, text: responseType === 'text' ? res.data : undefined }
  } catch (err) {
    return { ok: false, status: err?.response?.status || null, error: String(err?.message || err) }
  }
}

const realDelay = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); if (t?.unref) t.unref() })

// ── DB dedupe + upsert ──────────────────────────────────────────────────────

async function organizationExists(db, org) {
  const conds = []
  const params = []
  const site = normalizeWebsite(org.website || org.website_url)
  if (site) { conds.push('LOWER(website) = ?'); params.push(site) }
  const ein = String(org.ein || '').replace(/\D/g, '')
  if (ein) { conds.push("REPLACE(REPLACE(ein,'-',''),' ','') = ?"); params.push(ein) }
  const email = String(org.email || '').trim().toLowerCase()
  if (email) { conds.push('LOWER(email) = ?'); params.push(email) }
  const name = String(org.name || org.organization_name || '').trim().toLowerCase()
  const state = String(org.state || '').trim().toLowerCase()
  if (name) { conds.push('(LOWER(name) = ? AND LOWER(COALESCE(state, \'\')) = ?)'); params.push(name, state) }
  if (conds.length === 0) return true // no identity → treat as dup (skip)
  try {
    const row = await db
      .prepare(`SELECT id FROM organizations WHERE deleted_at IS NULL AND (${conds.join(' OR ')}) LIMIT 1`)
      .get(...params)
    return Boolean(row)
  } catch {
    return false // table shape differs in a bare DB — let insert decide
  }
}

async function insertOrganization(db, org) {
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  const id = crypto.randomUUID()
  await db
    .prepare(
      `INSERT INTO organizations
         (id, name, email, phone, website, mission, focus_areas, program_areas,
          applicant_type, organization_type, ein, city, state, contact_name, contact_title,
          created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'yana-web-crawler', ${nowFn}, ${nowFn})`,
    )
    .run(
      id,
      String(org.name || org.organization_name || '').trim(),
      org.email ? String(org.email).trim() : null,
      org.phone ? String(org.phone).trim() : null,
      normalizeWebsite(org.website || org.website_url),
      org.mission ? String(org.mission).slice(0, 4000) : null,
      JSON.stringify(Array.isArray(org.focus_areas) ? org.focus_areas : []),
      JSON.stringify(Array.isArray(org.program_areas) ? org.program_areas : []),
      org.applicant_type || org.organization_type || 'organization',
      org.organization_type || null,
      org.ein ? String(org.ein) : null,
      org.city || null,
      org.state || null,
      org.contact_name ? String(org.contact_name).slice(0, 200) : null,
      org.contact_title ? String(org.contact_title).slice(0, 200) : null,
    )
  return id
}

// ── Orchestration ───────────────────────────────────────────────────────────

/**
 * Run one broad-web client-discovery pass. Returns an audit summary; never
 * throws. All network access is injectable.
 */
export async function runYanaWebCrawl(db, {
  config = getYanaCrawlerConfig(),
  fetchImpl = defaultFetchImpl,
  headCheck = headForVerification,
  robotsCheck = isUrlAllowed,
  delay = realDelay,
  logger = log,
} = {}) {
  const summary = {
    ok: true,
    sources_run: [],
    fetched: 0,
    inserted: 0,
    skipped_dupes: 0,
    rejected_junk: 0,
    rejected_dead: 0,
    enriched_emails: 0,
    enriched_phones: 0,
    enriched_contacts: 0,
    robots_blocked: [],
  }

  if (!config.enabled) return { ...summary, ok: true, skipped: true, reason: 'crawler_disabled' }
  if (!config.sources.length) return { ...summary, ok: true, skipped: true, reason: 'no_sources_configured' }

  const robotsFetchText = async (u) => {
    const r = await fetchImpl(u, { responseType: 'text' })
    return { ok: r.ok === true, text: r.text || '' }
  }

  let remaining = config.maxPerRun
  for (const name of config.sources) {
    if (remaining <= 0) break
    const adapter = sources.get(name)
    if (!adapter) { logger?.warn?.(`unknown web source "${name}" — skipping`); continue }

    // Politeness: robots.txt on the adapter's base URL before fetching.
    if (adapter.baseUrl) {
      const verdict = await robotsCheck(adapter.baseUrl, { fetchText: robotsFetchText, userAgent: config.userAgent })
      if (!verdict.allowed) {
        summary.robots_blocked.push(name)
        logger?.warn?.(`robots.txt disallows ${name} (${adapter.baseUrl}) — skipping`)
        continue
      }
    }

    let candidates = []
    try {
      candidates = await adapter.fetchCandidates({ fetchImpl, limit: remaining, logger }) || []
    } catch (err) {
      logger?.warn?.(`source "${name}" fetch failed: ${err?.message || err}`)
      continue
    }
    summary.sources_run.push(name)

    for (const raw of candidates) {
      if (remaining <= 0) break
      summary.fetched += 1
      const org = raw || {}

      if (isJunkOrg(org)) { summary.rejected_junk += 1; continue }

      // Verify website liveness when present (real-only). No website → allowed
      // (org may still carry a usable email; funnel will gate on email anyway).
      const site = normalizeWebsite(org.website || org.website_url)
      if (site) {
        const head = await headCheck(site)
        if (config.perDomainDelayMs) await delay(config.perDomainDelayMs)
        if (!head || head.ok !== true) { summary.rejected_dead += 1; continue }
      }

      // Enrich a website-only org with its published contact details (email so
      // the funnel can qualify it, plus phone + contact person for richer
      // outreach packets). Same-domain, robots-respected.
      if (config.enrichEmails && site && (!org.email || !org.phone || !org.contact_name)) {
        try {
          const found = await enrichOrgContact(org, { fetchImpl, robotsCheck, delay, delayMs: config.perDomainDelayMs, userAgent: config.userAgent })
          if (found) {
            if (found.email && !org.email) { org.email = found.email; summary.enriched_emails += 1 }
            if (found.phone && !org.phone) { org.phone = found.phone; summary.enriched_phones += 1 }
            if (found.contact_name && !org.contact_name) {
              org.contact_name = found.contact_name
              org.contact_title = found.contact_title || null
              summary.enriched_contacts += 1
            }
          }
        } catch (err) {
          logger?.warn?.(`contact enrichment failed for "${org.name}": ${err?.message || err}`)
        }
      }

      if (await organizationExists(db, org)) { summary.skipped_dupes += 1; continue }

      try {
        await insertOrganization(db, org)
        summary.inserted += 1
        remaining -= 1
      } catch (err) {
        logger?.warn?.(`insert failed for "${org.name}": ${err?.message || err}`)
      }
    }
  }

  logger?.info?.('yana.web_crawl.done', summary)
  return summary
}

// ── Opt-in example source: ProPublica Nonprofit Explorer (public API) ────────
// Registered only when an operator names it in YANA_WEB_SOURCES. Provides org
// identity (name/EIN/location/type) for nonprofits; it carries no email, so
// those rows seed the org universe and become qualifiable after enrichment.

export function makeProPublicaNonprofitSource({ query = 'foundation', state = null } = {}) {
  const baseUrl = 'https://projects.propublica.org/nonprofits/api/v2/search.json'
  return {
    name: 'propublica_nonprofits',
    baseUrl,
    async fetchCandidates({ fetchImpl, limit = 100 } = {}) {
      const params = new URLSearchParams({ q: query })
      if (state) params.set('state[id]', state)
      const res = await fetchImpl(`${baseUrl}?${params.toString()}`, { responseType: 'json' })
      if (!res?.ok || !res.json) return []
      const orgs = Array.isArray(res.json.organizations) ? res.json.organizations : []
      return orgs.slice(0, limit).map((o) => ({
        name: o.name,
        ein: (o.ein === null || o.ein === undefined) ? null : String(o.ein),
        city: o.city || null,
        state: o.state || null,
        applicant_type: 'nonprofit',
        organization_type: 'nonprofit',
        mission: o.ntee_classification || null,
      }))
    },
  }
}

// ── Generic operator-configured feed sources (JSON / CSV) ────────────────────
// Let an operator point Yana at ANY vetted public org directory without code:
// set YANA_WEB_JSON_FEED_URL or YANA_WEB_CSV_FEED_URL and name 'json_feed' /
// 'csv_feed' in YANA_WEB_SOURCES. Fields are matched by common aliases.

const FIELD_ALIASES = Object.freeze({
  name: ['name', 'organization_name', 'org_name', 'organization', 'title'],
  email: ['email', 'contact_email', 'email_address', 'e_mail'],
  website: ['website', 'website_url', 'url', 'homepage', 'web'],
  city: ['city', 'town', 'locality'],
  state: ['state', 'state_id', 'st', 'province', 'region'],
  ein: ['ein', 'tax_id', 'taxid'],
  mission: ['mission', 'description', 'summary', 'about', 'ntee_classification'],
  organization_type: ['organization_type', 'org_type', 'type', 'category', 'sector'],
})

function pickField(row, aliases) {
  for (const a of aliases) {
    const v = row?.[a]
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim()
  }
  return null
}

/** Map an arbitrary feed row to an org candidate via field aliases. Pure. */
export function mapFeedRow(row = {}) {
  const get = (k) => pickField(row, FIELD_ALIASES[k])
  const orgType = get('organization_type')
  return {
    name: get('name'),
    email: get('email'),
    website: get('website'),
    city: get('city'),
    state: get('state'),
    ein: get('ein'),
    mission: get('mission'),
    organization_type: orgType,
    applicant_type: orgType || 'organization',
  }
}

function findArray(json) {
  if (Array.isArray(json)) return json
  for (const key of ['results', 'data', 'organizations', 'items', 'records', 'rows']) {
    if (Array.isArray(json?.[key])) return json[key]
  }
  return []
}

function splitCsvLine(line) {
  const out = []
  let cur = ''
  let q = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++ } else q = false } else cur += c
    } else if (c === '"') { q = true } else if (c === ',') { out.push(cur); cur = '' } else cur += c
  }
  out.push(cur)
  return out
}

/** Minimal CSV → array of objects keyed by lower-cased header. Pure. */
export function parseCsv(text) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.length > 0)
  if (!lines.length) return []
  const header = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase())
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line)
    if (!cells.some((c) => c.trim() !== '')) return null
    const obj = {}
    header.forEach((h, i) => { obj[h] = (cells[i] ?? '').trim() })
    return obj
  }).filter(Boolean)
}

export function makeJsonFeedSource({ url = process.env.YANA_WEB_JSON_FEED_URL || null } = {}) {
  return {
    name: 'json_feed',
    baseUrl: url,
    async fetchCandidates({ fetchImpl, limit = 200 } = {}) {
      if (!url) return []
      const res = await fetchImpl(url, { responseType: 'json' })
      if (!res?.ok || !res.json) return []
      return findArray(res.json).slice(0, limit).map(mapFeedRow).filter((r) => r.name)
    },
  }
}

export function makeCsvFeedSource({ url = process.env.YANA_WEB_CSV_FEED_URL || null } = {}) {
  return {
    name: 'csv_feed',
    baseUrl: url,
    async fetchCandidates({ fetchImpl, limit = 200 } = {}) {
      if (!url) return []
      const res = await fetchImpl(url, { responseType: 'text' })
      if (!res?.ok || !res.text) return []
      return parseCsv(res.text).slice(0, limit).map(mapFeedRow).filter((r) => r.name)
    },
  }
}

const KNOWN_SOURCE_FACTORIES = Object.freeze({
  propublica_nonprofits: makeProPublicaNonprofitSource,
  json_feed: makeJsonFeedSource,
  csv_feed: makeCsvFeedSource,
})

/** Register the vetted sources named in config.sources (operator opt-in). */
export function registerConfiguredWebSources(config = getYanaCrawlerConfig()) {
  const registered = []
  for (const name of config.sources) {
    if (sources.has(name)) { registered.push(name); continue }
    const factory = KNOWN_SOURCE_FACTORIES[name]
    if (factory) { registerWebSource(factory()); registered.push(name) }
  }
  return registered
}

export const __testing__ = { organizationExists, insertOrganization, defaultFetchImpl }
