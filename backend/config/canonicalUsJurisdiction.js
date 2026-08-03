/**
 * canonicalUsJurisdiction.js — evidence-backed correction for U.S. funders
 * whose stored `state` was copied from crawl/query noise instead of the funder.
 *
 * This registry is intentionally narrow. A rule must identify a concrete funder
 * or institution through its own hostname and/or identity fields. We never infer
 * state from description prose, profile location, or the crawl that found it.
 * Missing evidence is neutral.
 */

import { declaredStateFromTitle } from './stateTitleDeclaration.js'
import { isValidState, normalizeState } from '../utils/stateNormalization.js'

const URL_FIELDS = Object.freeze([
  'source_url',
  'application_url',
  'apply_url',
  'url',
  'evidence_url',
  'info_url',
  'final_url',
])

/**
 * Canonical jurisdiction rules for the concrete QA failures observed on
 * 2026-08-03.
 *
 * - Central Piedmont is a Charlotte/Mecklenburg County, North Carolina college;
 *   cpcc.edu and the institution's exact identity therefore establish NC.
 * - "Ohio RDA" explicitly identifies the Ohio Rural Development agency/program
 *   family. The pattern is anchored at the start of an identity field so a
 *   description that merely mentions Ohio never triggers it.
 */
export const CANONICAL_US_JURISDICTION_RULES = Object.freeze([
  Object.freeze({
    id: 'central_piedmont',
    state: 'NC',
    hosts: Object.freeze(['cpcc.edu']),
    identityPatterns: Object.freeze([
      /\bcentral piedmont(?: community college)?\b/i,
    ]),
  }),
  Object.freeze({
    id: 'ohio_rda',
    state: 'OH',
    hosts: Object.freeze([]),
    identityPatterns: Object.freeze([
      /^\s*ohio\s+(?:rda|rural development(?: administration|agency)?)\b/i,
    ]),
  }),
])

function hostnameOf(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  try {
    const parsed = new URL(raw.includes('://') ? raw : `https://${raw}`)
    return String(parsed.hostname || '').toLowerCase().replace(/^www\./, '').replace(/\.+$/, '') || null
  } catch {
    return null
  }
}

function hostMatches(actual, expected) {
  const host = String(actual ?? '').trim().toLowerCase().replace(/^www\./, '')
  const target = String(expected ?? '').trim().toLowerCase().replace(/^www\./, '')
  return Boolean(host && target && (host === target || host.endsWith(`.${target}`)))
}

function identityFields(row = {}) {
  return [
    row.title,
    row.name,
    row.sponsor,
    row.funder,
    row.funder_name,
    row.organization,
    row.agency,
  ].map((value) => String(value ?? '').trim()).filter(Boolean)
}

/**
 * Return a confirmed canonical U.S. state from a registered funder/institution,
 * or null when the row carries no such evidence.
 */
export function canonicalUsFunderJurisdiction(row = {}) {
  if (!row || typeof row !== 'object') return null
  const hosts = URL_FIELDS.map((field) => hostnameOf(row[field])).filter(Boolean)
  const identities = identityFields(row)

  for (const rule of CANONICAL_US_JURISDICTION_RULES) {
    const host = hosts.find((candidate) => rule.hosts.some((expected) => hostMatches(candidate, expected)))
    if (host) {
      return {
        state: rule.state,
        rule_id: rule.id,
        evidence: `host:${host}`,
      }
    }
    const identity = identities.find((candidate) => rule.identityPatterns.some((pattern) => pattern.test(candidate)))
    if (identity) {
      return {
        state: rule.state,
        rule_id: rule.id,
        evidence: `identity:${identity}`,
      }
    }
  }
  return null
}

/**
 * Resolve the state a user-facing or matching surface should trust.
 * Priority is objective canonical funder evidence, then the exact machine-minted
 * title declaration, then the stored state. A canonical funder can therefore
 * repair a crawl-stamped contradiction such as CPCC/OH being tagged Tennessee;
 * ordinary rows preserve their scope unchanged.
 */
export function resolvedUsOpportunityJurisdiction(row = {}) {
  const canonical = canonicalUsFunderJurisdiction(row)
  if (canonical) {
    return {
      state: canonical.state,
      is_national: false,
      confirmed: true,
      source: 'canonical_funder',
      rule_id: canonical.rule_id,
      evidence: canonical.evidence,
      stored_state: normalizeState(row.state) || null,
    }
  }

  const declared = declaredStateFromTitle(row)
  if (declared && isValidState(declared)) {
    return {
      state: declared,
      is_national: false,
      confirmed: true,
      source: 'declared_title',
      rule_id: null,
      evidence: 'title_state_declaration',
      stored_state: normalizeState(row.state) || null,
    }
  }

  const stored = normalizeState(row.state)
  if (stored && isValidState(stored)) {
    return {
      state: stored,
      is_national: false,
      confirmed: true,
      source: 'stored_state',
      rule_id: null,
      evidence: 'stored_state',
      stored_state: stored,
    }
  }

  const national = row.is_national === true || row.is_national === 1 ||
    /^(?:national|nationwide)$/i.test(String(row.state ?? row.geography ?? '').trim())
  return {
    state: null,
    is_national: national,
    confirmed: national,
    source: national ? 'stored_national' : null,
    rule_id: null,
    evidence: national ? 'stored_national' : null,
    stored_state: null,
  }
}

/**
 * Writer-side correction for registered U.S. funders. Unlike the generic
 * declared-title repair, this MAY override a non-empty stored state because the
 * registered host/identity is the objective jurisdiction and the stored value
 * is the known crawl-noise field being corrected.
 */
export function correctedCanonicalUsScope(row = {}) {
  const canonical = canonicalUsFunderJurisdiction(row)
  if (!canonical) return null
  const stored = normalizeState(row.state)
  const alreadyScoped = stored === canonical.state &&
    row.is_national !== true && row.is_national !== 1
  return alreadyScoped ? null : { state: canonical.state, is_national: 0 }
}

export default {
  CANONICAL_US_JURISDICTION_RULES,
  canonicalUsFunderJurisdiction,
  resolvedUsOpportunityJurisdiction,
  correctedCanonicalUsScope,
}
