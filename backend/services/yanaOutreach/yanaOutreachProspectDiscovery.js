/**
 * Yana — prospect discovery orchestrator (legacy filename `yanaOutreachProspectDiscovery.js`).
 *
 * Discovery is intentionally pluggable: callers (real prod code, tests, the
 * scheduler) inject a `searchAdapter` that knows how to actually fetch a
 * source and produce raw records. This file is responsible for:
 *   - picking which sources to query for the requested applicant_types
 *   - applying domain rate limits before fetching
 *   - normalizing raw records into prospect candidates
 *   - rejecting obviously bad records (no name, placeholder URLs, dupes)
 *   - persisting the survivors via the run store
 *
 * No real network calls happen in this file. That keeps it deterministic and
 * safe to import — the real fetching adapter is the one wired in by the
 * scheduler / route layer.
 */

import {
  LARRY_PUBLIC_PROSPECT_SOURCES,
  getSourcesForApplicantTypes,
  computeProspectTrustScore,
} from './yanaOutreachProspectSources.js'
import { isPlaceholderUrl, classifyEmail, getYanaOutreachConfig } from './yanaOutreachSafety.js'
import {
  PROSPECT_REJECTION_REASONS,
  PROSPECT_STATUS,
  makeProspectCandidate,
} from './yanaOutreachTypes.js'
import { checkDomainRateLimit, recordDomainRequest, upsertProspectCandidate } from './yanaOutreachRunStore.js'

/**
 * Pick a list of sources to fetch from for this run.
 */
export function planProspectFetches({ applicantTypes = [], maxSources = 5, includeNational = true } = {}) {
  const filtered = getSourcesForApplicantTypes(applicantTypes)
  // AN UNSERVED APPLICANT TYPE IS A COVERAGE GAP, NOT A LICENCE TO PROSPECT
  // EVERYTHING. The old fallback silently substituted the FULL source list
  // whenever `getSourcesForApplicantTypes` matched nothing, so an applicant
  // type the registry does not serve produced a maximal, entirely unrelated
  // prospect run that looked like a success. Fall back only when the caller
  // named no applicant type at all (a deliberately unscoped run).
  const askedForTypes = Array.isArray(applicantTypes) && applicantTypes.length > 0
  if (askedForTypes && filtered.length === 0) {
    return []
  }
  const candidates = filtered.length > 0 ? filtered : [...LARRY_PUBLIC_PROSPECT_SOURCES]

  // Prefer national + high-trust sources first, then add coverage variety.
  const sorted = [...candidates].sort((a, b) => {
    if (a.coverage === 'national' && b.coverage !== 'national') return -1
    if (b.coverage === 'national' && a.coverage !== 'national') return 1
    return (b.trust_score || 0) - (a.trust_score || 0)
  })

  const plan = sorted.slice(0, Math.max(1, maxSources)).map((src) => ({
    source_id: src.id,
    source_name: src.name,
    source_url: src.url,
    source_type: src.source_type,
    applicant_types: applicantTypes.length > 0 ? applicantTypes : src.applicant_types,
  }))

  // `includeNational: false` used to be a SILENT NO-OP — both branches returned
  // the same plan, so a caller that asked to exclude national sources got them
  // anyway (and the national-first sort put them at the front of the slice).
  if (!includeNational) {
    return plan.filter((entry) => {
      const src = sorted.find((s) => s.id === entry.source_id)
      return src?.coverage !== 'national'
    })
  }
  return plan
}

/**
 * Pure record → candidate normalization. Rejects obvious junk early.
 * Returns either { candidate } or { rejected, reason }.
 */
export function normalizeRawRecord(raw, planEntry = {}) {
  if (!raw || typeof raw !== 'object') {
    return { rejected: true, reason: PROSPECT_REJECTION_REASONS.NOT_PROBABLE_GRANTSEEKER }
  }

  const name = String(raw.organization_name || raw.name || '').trim()
  if (!name) return { rejected: true, reason: PROSPECT_REJECTION_REASONS.NO_NAME }

  if (raw.website_url && isPlaceholderUrl(raw.website_url)) {
    return { rejected: true, reason: PROSPECT_REJECTION_REASONS.PLACEHOLDER_DATA }
  }

  const email = raw.primary_contact_email || raw.email || null
  if (email) {
    const cls = classifyEmail(email)
    if (!cls.valid) {
      return { rejected: true, reason: PROSPECT_REJECTION_REASONS.EMAIL_INVALID_FORMAT }
    }
    if (cls.is_disposable) {
      return { rejected: true, reason: PROSPECT_REJECTION_REASONS.EMAIL_DISPOSABLE }
    }
  }

  // Government agencies are not GrantFlow's target customer. They issue
  // grants; our customers apply for grants.
  const orgType = String(raw.organization_type || '').toLowerCase()
  if (orgType === 'government' || orgType === 'federal_agency' || orgType === 'state_agency') {
    return { rejected: true, reason: PROSPECT_REJECTION_REASONS.GOVERNMENT_AGENCY }
  }

  if (!raw.city && !raw.state && !raw.address) {
    return { rejected: true, reason: PROSPECT_REJECTION_REASONS.NO_LOCATION }
  }

  const candidate = makeProspectCandidate({
    source_name: planEntry.source_name ?? raw.source_name ?? null,
    source_url: planEntry.source_url ?? raw.source_url ?? null,
    source_type: planEntry.source_type ?? raw.source_type ?? null,
    organization_name: name,
    organization_legal_name: raw.organization_legal_name ?? null,
    organization_type: raw.organization_type ?? null,
    organization_subtype: raw.organization_subtype ?? null,
    ein: raw.ein ? String(raw.ein).replace(/\D/g, '') : null,
    website_url: raw.website_url ?? null,
    primary_contact_name: raw.primary_contact_name ?? null,
    primary_contact_role: raw.primary_contact_role ?? null,
    primary_contact_email: email ?? null,
    primary_contact_phone: raw.primary_contact_phone ?? raw.phone ?? null,
    address: raw.address ?? null,
    city: raw.city ?? null,
    state: raw.state ?? null,
    zip: raw.zip ?? null,
    county: raw.county ?? null,
    geography_scope: raw.geography_scope ?? null,
    applicant_type: raw.applicant_type ?? planEntry.applicant_type ?? null,
    need_categories: Array.isArray(raw.need_categories) ? raw.need_categories : [],
    programs: Array.isArray(raw.programs) ? raw.programs : [],
    signals: raw.signals && typeof raw.signals === 'object' ? raw.signals : {},
    raw_payload: raw,
    status: PROSPECT_STATUS.DISCOVERED,
  })

  return { candidate, trust: computeProspectTrustScore(candidate) }
}

/**
 * Discover prospects by walking a planned set of fetches. The `searchAdapter`
 * is the only piece that touches a network or external API, and is required.
 *
 * Adapter contract:
 *   adapter({ planEntry, config }) -> Promise<{ records: Array<RawRecord> }>
 *   each RawRecord has at least: organization_name, source URL, location.
 *
 * Returns: { plan, fetched, candidates, rejected, trustOrdered }
 */
export async function discoverProspects({
  db,
  searchAdapter,
  applicantTypes = [],
  maxSources = 5,
  config = null,
  runId = null,
} = {}) {
  if (typeof searchAdapter !== 'function') {
    throw new Error('discoverProspects requires a searchAdapter function')
  }
  const cfg = config || getYanaOutreachConfig()
  const plan = planProspectFetches({ applicantTypes, maxSources })

  const fetched = []
  const candidates = []
  const rejected = []

  for (const entry of plan) {
    const domain = safeDomain(entry.source_url)
    if (db && domain) {
      const limit = await checkDomainRateLimit(db, domain, { perHour: cfg.rateLimitPerDomainPerHour })
      if (!limit.ok) {
        rejected.push({ entry, reason: limit.reason || 'domain_rate_limited' })
        continue
      }
    }
    let result
    try {
      result = await searchAdapter({ planEntry: entry, config: cfg })
    } catch (err) {
      rejected.push({ entry, reason: 'adapter_error', detail: err?.message || String(err) })
      continue
    }
    if (db && domain) {
      try {
        await recordDomainRequest(db, domain)
      } catch {
        // best-effort
      }
    }
    fetched.push({ entry, recordCount: result?.records?.length || 0 })
    const records = Array.isArray(result?.records) ? result.records : []
    for (const raw of records) {
      const normalized = normalizeRawRecord(raw, entry)
      if (normalized.rejected) {
        rejected.push({ entry, raw, reason: normalized.reason })
        continue
      }
      const candidate = { ...normalized.candidate, run_id: runId }
      if (db && cfg.persistProspects) {
        try {
          const saved = await upsertProspectCandidate(db, candidate)
          if (saved) candidates.push(saved)
        } catch (err) {
          rejected.push({ entry, raw, reason: 'persist_error', detail: err?.message || String(err) })
        }
      } else {
        candidates.push(candidate)
      }
    }
  }

  const trustOrdered = [...candidates].sort((a, b) => {
    return (computeProspectTrustScore(b) || 0) - (computeProspectTrustScore(a) || 0)
  })

  return {
    plan,
    fetched,
    candidates,
    rejected,
    trustOrdered,
  }
}

function safeDomain(url) {
  if (!url) return null
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}
