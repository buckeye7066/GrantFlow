/**
 * verification/index.js
 *
 * Coordinator for the free, keyless verification layer. Two responsibilities:
 *
 *   1. ASYNC enrichment (`enrichOpportunityVerification`, `enrichProfileGeo`):
 *      best-effort calls to ProPublica + Census that attach a structured
 *      `verification` signal to an opportunity/profile. These are meant to run
 *      during discovery/normalization (OUTSIDE the synchronous matcher hot
 *      loop) so the network cost is paid once per row, then cached.
 *
 *   2. SYNC influence (`verificationMatchAdjustment`): a pure, synchronous
 *      function the matcher calls with the ALREADY-ATTACHED `verification`
 *      signal. It returns a small, conservative, HONEST adjustment:
 *        - verified org sponsor  → small confidence boost
 *        - org opp the API said is fabricated/unresolvable → small down-weight
 *        - API never answered     → NO adjustment (never penalize on failure)
 *
 * The structured signal is observable (Sam/Anya can read `opp.verification`)
 * per the agent-observability rule.
 */

import { createLogger } from '../../utils/logger.js'
import { lookupByEin, lookupByName, REGISTRY_SOURCE } from './nonprofitRegistry.js'
import { resolveZip, resolveAddress, CENSUS_SOURCE } from './censusGeo.js'
import {
  isRegistryVerificationEnabled,
  isCensusGeoEnabled,
} from './verificationConfig.js'

const log = createLogger('verification')

// Entity classes for which org-registry verification is meaningful. An
// individual/family/student grant is NEVER expected to be a tax-exempt org, so
// we do not attempt (or penalize) registry verification for those.
const ORG_ENTITY_TYPES = new Set(['organization', 'nonprofit', 'business', 'government', 'researcher'])

/**
 * True when this opportunity TARGETS organizations (so an org-registry check
 * is relevant). We look at normalized entityTypesAllowed plus the explicit
 * requires* flags. Conservative: when applicability is unknown we DO NOT treat
 * it as org-targeted (avoids over-reaching verification on ambiguous rows).
 */
export function opportunityTargetsOrganizations(oppNorm) {
  if (!oppNorm) return false
  if (oppNorm.requiresNonprofit || oppNorm.requiresBusiness) return true
  const allowed = Array.isArray(oppNorm.entityTypesAllowed) ? oppNorm.entityTypesAllowed : []
  if (allowed.length === 0) return false
  return allowed.some((t) => ORG_ENTITY_TYPES.has(String(t)))
}

/**
 * Best-effort: confirm the SPONSOR of an org-targeted opportunity is a real,
 * tax-exempt org and surface NTEE/revenue. Returns the structured registry
 * signal (apiAnswered:false when disabled/down). NEVER throws.
 *
 * @param {object} rawOpp  raw opportunity row (reads sponsor / sponsor_ein / state)
 * @param {object} oppNorm normalized opportunity (for org-target gate)
 * @returns {Promise<object|null>} registry signal or null when not applicable
 */
export async function verifyOpportunitySponsor(rawOpp, oppNorm) {
  if (!isRegistryVerificationEnabled()) return null
  if (!opportunityTargetsOrganizations(oppNorm)) return null

  const ein = rawOpp?.sponsor_ein ?? rawOpp?.ein ?? null
  const sponsor = rawOpp?.sponsor ?? rawOpp?.funder ?? null
  const state = rawOpp?.state ?? null

  try {
    if (ein) return await lookupByEin(ein)
    if (sponsor && String(sponsor).trim().length >= 3) {
      return await lookupByName(sponsor, { state })
    }
  } catch (err) {
    // Defensive — the providers already swallow errors, but never let one
    // escape into the discovery/normalization path.
    log.warn('verifyOpportunitySponsor.failed', { error: err?.message })
  }
  return null
}

/**
 * Attach a `verification` signal to a normalized opportunity (mutating a copy).
 * Resolves the opportunity's stated geo (ZIP/state) and, when org-targeted,
 * the sponsor registry status. Best-effort; returns the same shape even when
 * everything is disabled/unanswered.
 *
 * @param {object} rawOpp
 * @param {object} oppNorm
 * @returns {Promise<object>} { source, verified, ntee, revenue_band, geo }
 */
export async function enrichOpportunityVerification(rawOpp, oppNorm) {
  const signal = {
    sources: [],
    verified: null,        // org verification verdict (null = not checked / API down)
    ntee: null,
    revenue_band: null,
    geo: null,             // { county, state, fips }
  }

  // Org registry (only for org-targeted rows).
  const registry = await verifyOpportunitySponsor(rawOpp, oppNorm)
  if (registry) {
    signal.sources.push(REGISTRY_SOURCE)
    if (registry.apiAnswered) {
      signal.verified = registry.verified
      signal.ntee = registry.ntee ?? null
      signal.revenue_band = registry.revenue_band ?? null
      signal.is501c3 = registry.is501c3 ?? null
      signal.registry_reason = registry.reason ?? null
    } else {
      // API did not answer → leave `verified` null (NEUTRAL, never penalize).
      signal.registry_reason = registry.reason ?? 'api_unanswered'
    }
  }

  // Census geo (deterministic county/FIPS for the opportunity's stated location).
  if (isCensusGeoEnabled()) {
    const geo = rawOpp?.geo_zip
      ? await resolveZip(rawOpp.geo_zip)
      : (rawOpp?.address_street
          ? await resolveAddress({
              street: rawOpp.address_street,
              city: rawOpp.city,
              state: rawOpp.state,
              zip: rawOpp.geo_zip ?? rawOpp.zip,
            })
          : null)
    if (geo) {
      signal.sources.push(CENSUS_SOURCE)
      if (geo.resolved) {
        signal.geo = { county: geo.county ?? null, state: geo.state ?? null, fips: geo.fips ?? null }
      }
    }
  }

  return signal
}

/**
 * Resolve a profile's primary ZIP/address to county/FIPS (deterministic geo).
 * Attach the result so the matcher's geo component can use county-level
 * precision. Best-effort; returns null when disabled/unresolved.
 *
 * @param {object} profile { zip|postal_code, city, state, address }
 * @returns {Promise<{county,state,fips}|null>}
 */
export async function enrichProfileGeo(profile) {
  if (!isCensusGeoEnabled()) return null
  const zip = profile?.zip ?? profile?.postal_code ?? profile?.zip_code ?? null
  let geo = null
  try {
    if (zip) geo = await resolveZip(zip)
    else if (profile?.address || profile?.street) {
      geo = await resolveAddress({
        street: profile.address ?? profile.street,
        city: profile.city,
        state: profile.state,
        zip,
      })
    }
  } catch (err) {
    log.warn('enrichProfileGeo.failed', { error: err?.message })
    return null
  }
  if (!geo?.resolved) return null
  return { county: geo.county ?? null, state: geo.state ?? null, fips: geo.fips ?? null }
}

// ---------------------------------------------------------------------------
// SYNC matcher influence — pure, no network. Reads a verification signal that
// was ATTACHED earlier (during async enrichment). Conservative + honest.
// ---------------------------------------------------------------------------

/**
 * Compute a small, honest match/confidence adjustment from a pre-attached
 * verification signal. Pure + synchronous — safe to call in the matcher.
 *
 * Rules (intentionally conservative):
 *   - verified === true  → +confidence (a verified tax-exempt sponsor is real).
 *   - verified === false AND the opp is org-targeted → SMALL score down-weight
 *     (the API actively said this org is not a listed tax-exempt entity). We
 *     down-weight, we NEVER hard-reject — honest-data rule + invariants.
 *   - verified == null (API down / not checked) → NO adjustment.
 *
 * @param {object|null} verification the attached `verification` signal
 * @param {object} [opts]
 * @param {boolean} [opts.orgTargeted] whether the opp targets organizations
 * @returns {{ scoreDelta:number, confidenceDelta:number, reasons:string[] }}
 */
export function verificationMatchAdjustment(verification, { orgTargeted = false } = {}) {
  const out = { scoreDelta: 0, confidenceDelta: 0, reasons: [] }
  if (!verification || typeof verification !== 'object') return out

  if (verification.verified === true) {
    out.confidenceDelta += 8
    out.reasons.push(`Verified tax-exempt sponsor (${verification.source || verification.sources?.[0] || 'registry'})`)
  } else if (verification.verified === false && orgTargeted) {
    // The API ANSWERED and the org is not a listed tax-exempt entity. Small
    // down-weight only — never a hard reject (never block discovery).
    out.scoreDelta -= 10
    out.confidenceDelta -= 10
    out.reasons.push('Org sponsor not found in IRS tax-exempt registry (down-weighted, not rejected)')
  }
  // verified == null → no adjustment (API down / not checked / not org-targeted).
  return out
}

export default {
  opportunityTargetsOrganizations,
  verifyOpportunitySponsor,
  enrichOpportunityVerification,
  enrichProfileGeo,
  verificationMatchAdjustment,
}
