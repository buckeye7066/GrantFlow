// crawler-os/pageFacts.js
//
// THE single registry for Phase 0.1 page-fact provenance — the additive,
// NULL-default storage a later profile-blind extractor will populate. Every
// producer/consumer of these fields is DRIVEN by this module (column lists,
// OS->live mapping, validators) so the OS shape, the OS store, the live catalog
// columns, the boot schema invariant, and the drift check can never silently
// drift apart (the repo's registry + totality rule).
//
// TWO vocabularies exist BY DESIGN and this registry is the ONLY bridge:
//   - OS shape (contract.makeOpportunity): `funding.is_loan` /
//     `funding.requires_cost_share` / `geography.national`.
//   - LIVE catalog (funding_opportunities): `is_loan` / `requires_match` /
//     `is_national`.
// `buildLivePageFactColumns` is the one place that maps OS-store -> live names.

// Pure data + tiny pure validators. No I/O, no DB, no network.

/**
 * The additive page-fact COLUMNS, each mapping the OS memory/SQL-store column to
 * the live `funding_opportunities` column, with the SQL type at each side and a
 * `kind` that drives validation + (de)serialization at every write site.
 */
export const PAGE_FACT_COLUMNS = Object.freeze([
  { field: 'eligibility_text', osStoreColumn: 'eligibility_text', osStoreType: 'TEXT', liveColumn: 'eligibility_text', liveType: 'TEXT', kind: 'text' },
  { field: 'eligibility_bullets', osStoreColumn: 'eligibility_bullets_json', osStoreType: 'TEXT', liveColumn: 'eligibility_bullets', liveType: 'TEXT', kind: 'json_array' },
  { field: 'page_fact_schema_version', osStoreColumn: 'page_fact_schema_version', osStoreType: 'INTEGER', liveColumn: 'page_fact_schema_version', liveType: 'INTEGER', kind: 'positive_int' },
  { field: 'field_provenance', osStoreColumn: 'field_provenance_json', osStoreType: 'TEXT', liveColumn: 'field_provenance', liveType: 'TEXT', kind: 'json_object' },
].map(Object.freeze));

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

/** Live column NAMES the drift check / migration must verify. */
export const PAGE_FACT_MIGRATION_COLUMN_NAMES = Object.freeze(PAGE_FACT_MIGRATION_COLUMNS.map((c) => c.column));

/** OS-store column names these facts occupy (the merge/upsert surface). */
export const PAGE_FACT_OS_STORE_COLUMNS = Object.freeze(PAGE_FACT_COLUMNS.map((c) => c.osStoreColumn));

/** `col type` defs for the OS-store columns — DRIVES applySchema + SCHEMA_DDL. */
export const PAGE_FACT_OS_STORE_COLUMN_DEFS = Object.freeze(
  PAGE_FACT_COLUMNS.map((c) => `${c.osStoreColumn} ${c.osStoreType}`),
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

/**
 * Array of nonblank STRING bullets; [] when none. Non-string items (objects,
 * numbers, null) are DROPPED — never coerced (`[{}]` must not become "[object
 * Object]"). Accepts an array or a JSON-string array.
 */
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
    if (typeof item !== 'string') continue; // ONLY string items — never coerce
    const s = item.trim();
    if (s) out.push(s);
  }
  return out;
}

/**
 * A valid POSITIVE INTEGER schema version, else null. Accepts a real number or
 * an ALL-DIGITS string only — booleans (`Number(true) === 1`), objects, NaN, and
 * fractional / signed values are rejected. Guards the live INTEGER column
 * (Postgres rejects '' / 'abc') and the meaning of "version".
 */
export function cleanSchemaVersion(v) {
  let n;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && /^\d+$/.test(v.trim())) n = Number(v.trim());
  else return null; // booleans, objects, null, NaN-y strings
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * A nonempty, VALIDATED provenance object, else null. Accepts an object or a
 * JSON string. Each kept ENTRY must be a PLAIN object (a `{...}` literal /
 * JSON.parse output — NOT a class instance) that carries an own `value` which is
 * not undefined (the stated fact), and must be serializable. Entries that are
 * class instances, arrays, non-objects, missing `value`, `{ value: undefined }`,
 * or unserializable are DROPPED — so `{}` / `[]` / bad JSON / `{ is_loan: {} }` /
 * `{ value: undefined }` / a class instance never overwrite a stored fact during
 * a merge. Returns null when nothing valid remains.
 */
export function cleanFieldProvenance(v) {
  let obj = v;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    try { obj = JSON.parse(s); } catch { return null; }
  }
  if (!isPlainObject(obj)) return null;
  const out = {};
  for (const [key, entry] of Object.entries(obj)) {
    if (!isPlainObject(entry)) continue; // plain objects only — never a class instance
    // `value` must be an OWN, defined property. `{ value: undefined }` serializes
    // to `{}` and would clobber good evidence during a merge, so it is not a fact.
    if (!Object.prototype.hasOwnProperty.call(entry, 'value') || entry.value === undefined) continue;
    let serialized;
    try { serialized = JSON.stringify(entry); } catch { continue; } // reject circular / unserializable
    if (typeof serialized !== 'string') continue;
    out[key] = entry;
  }
  return Object.keys(out).length ? out : null;
}

/** True only for a plain object literal / JSON.parse output — never a class instance or array. */
function isPlainObject(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Merge two provenance objects per canonical field: incoming wins for a key it
 * supplies, existing keys are PRESERVED (a re-crawl that lacks a fact never
 * drops one already learned — mirrors the amount_status "never downgrade" rule).
 * Both sides are validated first, so a malformed incoming entry can never wipe a
 * good stored one. Returns null only when neither side has a valid fact.
 */
export function mergeFieldProvenance(existing, incoming) {
  const a = cleanFieldProvenance(existing);
  const b = cleanFieldProvenance(incoming);
  if (!a && !b) return null;
  if (!a) return b;
  if (!b) return a;
  return { ...a, ...b };
}

/** Validate a raw value by its registry `kind`; null when not a real fact. */
function cleanByKind(kind, v) {
  switch (kind) {
    case 'text': return cleanEligibilityText(v);
    case 'json_array': { const a = cleanEligibilityBullets(v); return a.length ? a : null; }
    case 'positive_int': return cleanSchemaVersion(v);
    case 'json_object': return cleanFieldProvenance(v);
    default: return null;
  }
}

/**
 * buildLivePageFactColumns — map an OS-store row to the LIVE catalog columns for
 * the populated page facts ONLY (the single OS->live name mapping). Validated
 * per `kind`; JSON kinds are serialized. An unset/blank/malformed fact is
 * omitted, so it never overwrites a stored value and the live INTEGER column
 * never receives ''. `field_provenance` still needs a per-key merge against the
 * live row — the caller (persistRun) does that with mergeFieldProvenance().
 */
export function buildLivePageFactColumns(osRow) {
  const out = {};
  for (const col of PAGE_FACT_COLUMNS) {
    const cleaned = cleanByKind(col.kind, osRow?.[col.osStoreColumn]);
    if (cleaned === null) continue;
    out[col.liveColumn] = (col.kind === 'json_array' || col.kind === 'json_object')
      ? JSON.stringify(cleaned)
      : cleaned;
  }
  return out;
}

/**
 * buildOsStorePageFactColumns — the OS-store column shape to persist for a
 * write, validated and MERGED with any fact already on the row (`existing`) so a
 * blank/empty/malformed incoming fact never overwrites a stored one; provenance
 * is merged per canonical field. `opp` is a canonical OS Opportunity (contract
 * field names); `existing` is a prior OS-store row (osStoreColumn names) or null.
 * Returns exactly the PAGE_FACT_OS_STORE_COLUMNS keys.
 */
export function buildOsStorePageFactColumns(existing, opp) {
  const incomingText = cleanEligibilityText(opp?.eligibility_text);
  const incomingBullets = cleanEligibilityBullets(opp?.eligibility_bullets);
  const incomingVersion = cleanSchemaVersion(opp?.page_fact_schema_version);
  const existingText = existing ? cleanEligibilityText(existing.eligibility_text) : null;
  const existingBullets = existing ? cleanEligibilityBullets(existing.eligibility_bullets_json) : [];
  const existingVersion = existing ? cleanSchemaVersion(existing.page_fact_schema_version) : null;
  const mergedProvenance = mergeFieldProvenance(existing ? existing.field_provenance_json : null, opp?.field_provenance);
  const bullets = incomingBullets.length ? incomingBullets : existingBullets;
  return {
    eligibility_text: incomingText ?? existingText,
    eligibility_bullets_json: JSON.stringify(bullets),
    page_fact_schema_version: incomingVersion ?? existingVersion,
    field_provenance_json: mergedProvenance ? JSON.stringify(mergedProvenance) : null,
  };
}

/** Does this canonical OS Opportunity carry ANY valid page fact worth persisting? */
export function hasAnyPageFact(opp) {
  return Boolean(
    cleanEligibilityText(opp?.eligibility_text) ||
    cleanEligibilityBullets(opp?.eligibility_bullets).length ||
    cleanSchemaVersion(opp?.page_fact_schema_version) ||
    cleanFieldProvenance(opp?.field_provenance),
  );
}

export default {
  PAGE_FACT_COLUMNS,
  PAGE_FACT_MIGRATION_COLUMNS,
  PAGE_FACT_MIGRATION_COLUMN_NAMES,
  PAGE_FACT_OS_STORE_COLUMNS,
  PAGE_FACT_OS_STORE_COLUMN_DEFS,
  PAGE_FACT_TRISTATE_FIELDS,
  cleanEligibilityText,
  cleanEligibilityBullets,
  cleanSchemaVersion,
  cleanFieldProvenance,
  mergeFieldProvenance,
  buildLivePageFactColumns,
  buildOsStorePageFactColumns,
  hasAnyPageFact,
};
