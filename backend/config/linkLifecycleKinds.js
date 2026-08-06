/**
 * Canonical opportunity-kind contract for link verification and repair.
 *
 * Crawler OS owns the five apply-capable kinds. `DIRECT` is retained only as
 * the legacy spelling used by older catalog rows; NULL and blank values are
 * classified as that legacy kind explicitly so they remain visible in health
 * receipts instead of disappearing from the denominator.
 */

import { APPLICABLE_KINDS } from '../crawler-os/contract.js'
import { isPointerKind, pointerKindSql } from './opportunityKindClasses.js'

export const LEGACY_LINK_LIFECYCLE_KIND = 'DIRECT'

export const LINK_LIFECYCLE_KINDS = Object.freeze([
  LEGACY_LINK_LIFECYCLE_KIND,
  ...APPLICABLE_KINDS,
])

const quoteList = (values) => values.map((value) => `'${value}'`).join(', ')
const LINK_LIFECYCLE_KIND_LIST_SQL = `(${quoteList(LINK_LIFECYCLE_KINDS)})`

export function isLegacyDefaultedLinkLifecycleKind(kind) {
  return kind === null || kind === undefined || String(kind).trim() === ''
}

export function normalizeLinkLifecycleKind(kind) {
  if (isLegacyDefaultedLinkLifecycleKind(kind)) return LEGACY_LINK_LIFECYCLE_KIND
  return String(kind).trim().toUpperCase()
}

export function isLinkLifecycleKind(kind) {
  return LINK_LIFECYCLE_KINDS.includes(normalizeLinkLifecycleKind(kind))
}

/** SQL twin of `isLegacyDefaultedLinkLifecycleKind`. */
export function legacyDefaultedLinkLifecycleKindSql(column) {
  return `TRIM(COALESCE(${column}, '')) = ''`
}

/**
 * SQL-normalize a stored kind. UPPER/TRIM is deliberate: production contains
 * mixed-case values and whitespace drift, while NULL/blank are legacy DIRECT.
 */
export function normalizedLinkLifecycleKindSql(column) {
  return `CASE WHEN ${legacyDefaultedLinkLifecycleKindSql(column)} THEN '${LEGACY_LINK_LIFECYCLE_KIND}' ELSE UPPER(TRIM(${column})) END`
}

/** SQL twin of `isLinkLifecycleKind`. */
export function linkLifecycleKindSql(column) {
  return `${normalizedLinkLifecycleKindSql(column)} IN ${LINK_LIFECYCLE_KIND_LIST_SQL}`
}

/**
 * Structural pointer predicate shared by mission health and lifecycle writers.
 * The finite pointer vocabulary remains owned by opportunityKindClasses.
 */
export function pointerOpportunityRowSql(alias = '') {
  const prefix = alias ? `${alias}.` : ''
  const kindColumn = (name) => `TRIM(${prefix}${name})`
  return [
    pointerKindSql(kindColumn('opportunity_kind')),
    pointerKindSql(kindColumn('result_kind')),
    pointerKindSql(kindColumn('opportunity_type')),
    pointerKindSql(kindColumn('type')),
    `LOWER(TRIM(COALESCE(${prefix}result_kind, ''))) = 'action_step'`,
  ].map((part) => `(${part})`).join(' OR ')
}

export function isPointerOpportunityRow(row = {}) {
  return [row.opportunity_kind, row.result_kind, row.opportunity_type, row.type]
    .some((kind) => isPointerKind(kind)) ||
    String(row.result_kind || '').trim().toLowerCase() === 'action_step'
}

/**
 * Authoritative lifecycle denominator: one of the six lifecycle kinds and not
 * a structurally-declared pointer/resource row.
 */
export function linkLifecycleOpportunitySql(alias = '') {
  const prefix = alias ? `${alias}.` : ''
  return `(${linkLifecycleKindSql(`${prefix}opportunity_kind`)}) AND NOT (${pointerOpportunityRowSql(alias)})`
}

export default {
  LEGACY_LINK_LIFECYCLE_KIND,
  LINK_LIFECYCLE_KINDS,
  isLegacyDefaultedLinkLifecycleKind,
  normalizeLinkLifecycleKind,
  isLinkLifecycleKind,
  legacyDefaultedLinkLifecycleKindSql,
  normalizedLinkLifecycleKindSql,
  linkLifecycleKindSql,
  pointerOpportunityRowSql,
  isPointerOpportunityRow,
  linkLifecycleOpportunitySql,
}
