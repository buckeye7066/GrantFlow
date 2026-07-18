// crawler-os/pageFacts.js
//
// THE single registry for Phase 0.1 page-fact provenance — the additive,
// NULL-default storage a later profile-blind extractor will populate. Every
// producer/consumer of these fields reads THIS module so the OS shape, the OS
// store, the live catalog columns, the boot schema invariant, and the drift
// check can never silently drift apart (the repo's registry + totality rule).
//
// TWO vocabularies exist BY DESIGN and this registry is the ONLY bridge:
//   - OS shape (contract.makeOpportunity): `funding.is_loan` /
//     `funding.requires_cost_share` / `geography.national`.
//   - LIVE catalog (funding_opportunities): `is_loan` / `requires_match` /
//     `is_national`.
// `osOppToLiveRow` is the only place allowed to hand-map these names.

// Pure data + tiny pure validators. No I/O, no DB, no network.

/**
 * The additive page-fact COLUMNS, each mapping the OS memory/SQL-store column
 * name to the live `funding_opportunities` column name.
 *   kind drives validation + (de)serialization at the write sites.
 */
export const PAGE_FACT_COLUMNS = Object.freeze([
  Object.freeze({ field: 'eligibility_text', osStoreColumn: 'eligibility_text', liveColumn: 'eligibility_text', kind: 'text' }),
  Object.freeze({ field: 'eligibility_bullets', osStoreColumn: 'eligibility_bullets_json', liveColumn: 'eligibility_bullets', kind: 'json_array' }),
  Object.freeze({ field: 'page_fact_schema_version', osStoreColumn: 'page_fact_schema_version', liveColumn: 'page_fact_schema_version', kind: 'positive_int' }),
  Object.freeze({ field: 'field_provenance', osStoreColumn: 'field_provenance_json', liveColumn: 'field_provenance', kind: 'json_object' }),
]);

/**
 * Live catalog columns ADDED by migration 144 / pg 0148. `eligibility_bullets`
 * PRE-EXISTED (schema.sql / pg 0001_init) so it is deliberately NOT here — it is
 * threaded through storage but never DDL-added by this program.
 */
export const PAGE_FACT_MIGRATION_COLUMNS = Object.freeze([
  Object.freeze({ column: 'eligibility_text', type: 'TEXT' }),
  Object.freeze({ column: 'page_fact_schema_version', type: 'INTEGER' }),
  Object.freeze({ column: 'field_provenance', type: 'TEXT' }),
]);

/** Every OS-store column these facts occupy — the applySchema/SCHEMA_DDL surface. */
export const PAGE_FACT_OS_STORE_COLUMNS = Object.freeze(
  PAGE_FACT_COLUMNS.map((c) => c.osStoreColumn),
);

/**
 * Tri-state facts that live INSIDE `field_provenance`. An ABSENT provenance key
 * means "not stated"; a present `{ value: true|false }` is a STATED fact. The
 * boolean columns below stay the coalesced view existing consumers keep reading
 * — the provenance is the only place the "not stated" third state is recorded.
 * `provenanceKey` is the canonical (OS-vocabulary) key written into the JSON.
 */
export const PAGE_FACT_TRISTATE_FIELDS = Object.freeze([
  Object.freeze({ provenanceKey: 'is_loan', osFundingKey: 'is_loan', liveColumn: 'is_loan' }),
  Object.freeze({ provenanceKey: 'requires_cost_share', osFundingKey: 'requires_cost_share', liveColumn: 'requires_match' }),
  Object.freeze({ provenanceKey: 'national', osGeographyKey: 'national', liveColumn: 'is_national' }),
]);

// ---- validators (a blank / empty / malformed fact is NOT a fact) ------------

/** Nonblank eligibility prose, else null. */
export function cleanEligibilityText(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s : null;
}

/** Array (or JSON-string array) of nonblank bullets; [] when none. */
export function cleanEligibilityBullets(v) {
  let arr = v;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return [];
    try { arr = JSON.parse(s); } catch { return []; }
  }
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const item of arr) {
    const s = String(item ?? '').trim();
    if (s) out.push(s);
  }
  return out;
}

/**
 * A valid POSITIVE INTEGER schema version, else null. Guards the live INTEGER
 * column: Postgres rejects '' / 'abc', and 0 / negatives are not real versions.
 */
export function cleanSchemaVersion(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * A nonempty, VALIDATED provenance object, else null. Accepts an object or a
 * JSON string; drops malformed / non-object entries; returns null when nothing
 * valid remains (so '' / '{}' / '[]' / bad JSON never overwrite a stored fact).
 * Each kept entry is a plain object (the `{ value, evidence_snippet, source }`
 * shape); a bare scalar value is not evidence and is dropped.
 */
export function cleanFieldProvenance(v) {
  let obj = v;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    try { obj = JSON.parse(s); } catch { return null; }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const out = {};
  for (const [key, entry] of Object.entries(obj)) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) out[key] = entry;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Merge two provenance objects per canonical field: incoming wins for a key it
 * supplies, existing keys are PRESERVED (a re-crawl that lacks a fact never
 * drops one already learned — mirrors the amount_status "never downgrade" rule).
 * Returns null only when neither side has a valid fact.
 */
export function mergeFieldProvenance(existing, incoming) {
  const a = cleanFieldProvenance(existing);
  const b = cleanFieldProvenance(incoming);
  if (!a && !b) return null;
  if (!a) return b;
  if (!b) return a;
  return { ...a, ...b };
}

export default {
  PAGE_FACT_COLUMNS,
  PAGE_FACT_MIGRATION_COLUMNS,
  PAGE_FACT_OS_STORE_COLUMNS,
  PAGE_FACT_TRISTATE_FIELDS,
  cleanEligibilityText,
  cleanEligibilityBullets,
  cleanSchemaVersion,
  cleanFieldProvenance,
  mergeFieldProvenance,
};
