import { SECTION_METADATA } from "../config/sectionMetadata.js"

export const SENTINEL_VALUES = new Set(["", "unknown", "n/a", "none", "null", "undefined"])

const warnedFields = new Set()

// Production rule (Goal 9 — explainable):
// We log noisy "missing metadata" warnings only when the build is the
// Vite dev server OR an opt-in strict mode is on. In production the
// resolver gracefully humanizes the field key and infers a format from
// the value's runtime type, so legacy / intake / new fields render
// cleanly without flooding the user's console. Set
// VITE_STRICT_PROFILE_METADATA=true in CI / E2E to surface drift loudly.
const STRICT_METADATA = import.meta.env?.VITE_STRICT_PROFILE_METADATA === "true"
const IS_DEV = Boolean(import.meta.env?.DEV)

function warnMissingMetadata(sectionKey, fieldKey, detail, { strictBypass = false } = {}) {
  const key = `${sectionKey || "unknown"}:${fieldKey || "unknown"}:${detail}`
  if (warnedFields.has(key)) return
  warnedFields.add(key)
  const message = `[fieldDisplay] Missing or invalid SECTION_METADATA for profile field ${sectionKey}.${fieldKey}: ${detail}`
  // Strict mode (CI / E2E) throws so misconfigurations fail the build;
  // strictBypass=true is reserved for cases where the renderer
  // recovered gracefully (e.g. coerced an array/object to a list).
  if (STRICT_METADATA && !strictBypass) throw new Error(message)
  // In dev we warn so engineers see drift; in production we stay quiet
  // because the resolver's humanize-fallback already renders a sensible
  // label and value (no white-screens, no broken cards).
  if (IS_DEV) console.warn(message, { sectionKey, fieldKey })
}

/**
 * Humanize a snake_case / kebab-case / camelCase field key into a
 * sentence-case label. Used as the fallback when SECTION_METADATA does
 * not declare the field — so a never-seen-before key from a fresh
 * profile shape still renders something readable instead of "Unknown
 * field".
 */
export function humanizeFieldKey(fieldKey) {
  const raw = String(fieldKey ?? "").trim()
  if (!raw) return ""
  // Replace separators, split camelCase, collapse whitespace.
  const spaced = raw
    .replace(/[_\-./]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
  if (!spaced) return ""
  // Sentence case: capitalise the first letter; preserve common acronyms
  // (EIN, UEI, SAM, FAFSA, GPA, ACT, SAT, IRS, NFPA, ISO, ZIP) so labels
  // read naturally for funding contexts.
  const ACRONYMS = new Set([
    "ein", "uei", "sam", "fafsa", "gpa", "act", "sat", "irs", "nfpa",
    "iso", "zip", "naics", "cage", "ssn", "ssi", "ssdi", "snap", "tanf",
    "wic", "chip", "liheap", "ada", "msi", "hbcu", "tcu", "fqhc",
    "cdfi", "stem", "url", "id", "us", "usa",
  ])
  return spaced
    .split(" ")
    .map((word, i) => {
      const lower = word.toLowerCase()
      if (ACRONYMS.has(lower)) return word.toUpperCase()
      if (i === 0) return lower.charAt(0).toUpperCase() + lower.slice(1)
      return lower
    })
    .join(" ")
}

// Defensive: any path that ends up calling `String(obj)` on a real
// non-array object produces the literal "[object Object]" — a value that
// is never useful to a user and that earlier slipped through every UI
// surface (Profile overview, Anya context dumps, comprehensive forms,
// etc.) when the formatter forgot to recurse. By recognising it here
// (and any "[object …]" toString variant) and at the
// looksLikeObjectStringification check below, we make
// `normalizeDisplayString` the global trap-door so a regression in any
// downstream renderer can never leak the raw stringification to the
// user. Mission goal 9 (explainable) + goal 10 (UI must not show raw
// stringification) — applies to every profile, not just Anastasia.
const RAW_OBJECT_TOSTRING_RE = /^\[object [A-Za-z][A-Za-z0-9_$]*\]$/

export function looksLikeObjectStringification(value) {
  if (typeof value !== "string") return false
  return RAW_OBJECT_TOSTRING_RE.test(value.trim())
}

export function isSentinelDisplayValue(value) {
  if (value === null || value === undefined) return true
  const raw = String(value).trim()
  if (looksLikeObjectStringification(raw)) return true
  return SENTINEL_VALUES.has(raw.toLowerCase())
}

export function normalizeDisplayString(value) {
  if (value === null || value === undefined) return null
  // Catch `String(obj)` / `String(arr)` accidents BEFORE any other
  // logic so the ugly literal can never appear in the UI for any
  // profile.
  if (typeof value === "object") {
    return null
  }
  const raw = String(value).trim()
  if (isSentinelDisplayValue(raw)) return null
  const withoutTrailingUnknown = raw.replace(/\s+unknown\s*$/i, "").trim()
  if (!withoutTrailingUnknown || isSentinelDisplayValue(withoutTrailingUnknown)) return null
  return withoutTrailingUnknown
}

export function getFieldMetadata(sectionKey, fieldKey, metadata = SECTION_METADATA) {
  return metadata?.[sectionKey]?.fields?.find((field) => field.name === fieldKey) ?? null
}

export function getFieldFormat(sectionKey, fieldKey, metadata = SECTION_METADATA) {
  return getFieldMetadata(sectionKey, fieldKey, metadata)?.format ?? null
}

export function formatFieldLabel(sectionKey, fieldKey, metadata = SECTION_METADATA) {
  const metadataLabel = getFieldMetadata(sectionKey, fieldKey, metadata)?.label
  if (metadataLabel) return metadataLabel
  // Soft-warn (dev / strict only) and humanize the key. We intentionally
  // never return "Unknown field" in production: a humanized label is
  // always more useful for the user, and the warning is enough signal
  // for engineers to add proper metadata when they see it.
  warnMissingMetadata(sectionKey, fieldKey, "label", { strictBypass: true })
  const humanized = humanizeFieldKey(fieldKey)
  return humanized || "Unknown field"
}

export function formatStatusLabel(value) {
  return String(value || "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function formatCurrency(value, { cents = false } = {}) {
  const amount = Number(value)
  if (!Number.isFinite(amount)) return null
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(cents ? amount / 100 : amount)
}

function formatDateValue(value, { includeTime = false } = {}) {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return includeTime ? date.toLocaleString() : date.toLocaleDateString()
}

function formatBooleanTri(value) {
  if (value === null || value === undefined || value === "") return "Unknown"
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase()
    if (["unknown", "n/a", "null", "undefined"].includes(normalized)) return "Unknown"
    if (["true", "yes", "y", "1"].includes(normalized)) return "Yes"
    if (["false", "no", "n", "0"].includes(normalized)) return "No"
  }
  return value ? "Yes" : "No"
}

/**
 * Format any value for display under a `json`-typed field without ever
 * leaking the JS default `[object Object]` toString. Nested objects are
 * recursively summarised down to a small bounded depth, scalars are
 * normalised through `normalizeDisplayString`, and empty / sentinel
 * values collapse to `null` so callers can fall back to the standard
 * em-dash placeholder. (Goal 9 — explainable + Goal 10 — UI must not show
 * raw object stringification.)
 */
function formatJsonValue(value, depth = 0) {
  const MAX_DEPTH = 3
  if (value === null || value === undefined) return null
  if (typeof value === "boolean") return value ? "Yes" : "No"
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null
  if (typeof value === "string") return normalizeDisplayString(value)
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => formatJsonValue(item, depth + 1))
      .filter((part) => part && part !== "—")
    return parts.length > 0 ? parts.join("; ") : null
  }
  if (typeof value === "object") {
    if (depth >= MAX_DEPTH) {
      // Avoid infinite recursion (and absurdly long previews) by collapsing
      // deep objects to a count summary instead of dumping every key.
      const keyCount = Object.keys(value).length
      return keyCount > 0 ? `${keyCount} field${keyCount === 1 ? "" : "s"}` : null
    }
    const parts = []
    for (const [key, inner] of Object.entries(value)) {
      const innerFormatted = formatJsonValue(inner, depth + 1)
      if (innerFormatted && innerFormatted !== "—") {
        const label = String(key).replace(/[_-]+/g, " ")
        parts.push(`${label}: ${innerFormatted}`)
      }
    }
    return parts.length > 0 ? parts.join(", ") : null
  }
  return null
}

function normalizeStringArrayEntry(value) {
  if (value === null || value === undefined) return []
  if (Array.isArray(value)) return value.flatMap((entry) => normalizeStringArrayEntry(entry))
  if (typeof value === "object") {
    return Object.values(value).flatMap((entry) => normalizeStringArrayEntry(entry))
  }
  const normalized = normalizeDisplayString(value)
  return normalized ? [normalized] : []
}

/**
 * Clean up a string-array value for DISPLAY: split on common separators,
 * trim, de-duplicate (case-insensitive), and drop empties / sentinels. This
 * fixes legacy / intake fields (notably `keywords (intake)`) whose stored
 * value is a single string with run-together + comma-separated duplicates
 * (e.g. ["churchministry, church, ministry"]) so the user sees a clean,
 * unique, comma-separated list instead of repeated, jammed-together tokens.
 *
 * Display-only: it never mutates stored data.
 */
export function cleanStringArrayForDisplay(value) {
  // Flatten arrays/objects to scalar strings first.
  const flat = normalizeStringArrayEntry(value)
  const out = []
  const seen = new Set()
  for (const entry of flat) {
    // Split a run-together blob on commas, semicolons, pipes, slashes, and
    // newlines. We deliberately do NOT split on spaces — multi-word tags like
    // "youth ministry" are legitimate single keywords.
    const tokens = String(entry)
      .split(/[,;|/\n]+/)
      .map((t) => t.trim())
      .filter(Boolean)
    for (const token of tokens) {
      const cleaned = normalizeDisplayString(token)
      if (!cleaned) continue
      const dedupeKey = cleaned.toLowerCase()
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)
      out.push(cleaned)
    }
  }
  return out
}

/**
 * Infer a sensible format from a raw value's runtime type when no
 * metadata is declared. Used as the fallback path for formatFieldValue
 * so legacy / intake / new fields always render cleanly.
 */
function inferFormatFromValue(value) {
  if (value === null || value === undefined || value === "") return "string"
  if (Array.isArray(value)) return "string_array"
  if (typeof value === "object") return "json"
  if (typeof value === "boolean") return "boolean_tri"
  if (typeof value === "number") return "string"
  return "string"
}

export function formatFieldValue(sectionKey, fieldKey, value, metadata = SECTION_METADATA) {
  const field = getFieldMetadata(sectionKey, fieldKey, metadata)
  let format
  if (field) {
    format = field.format ?? "string"
  } else {
    // No metadata for this field — soft-warn (dev / strict only) and
    // infer a renderable format from the value's runtime type so the
    // user sees their data, not "—".
    warnMissingMetadata(sectionKey, fieldKey, "field", { strictBypass: true })
    format = inferFormatFromValue(value)
  }
  if (value === null || value === undefined || value === "") return "—"

  if (format === "currency_usd" || format === "currency_cents_usd") {
    return formatCurrency(value, { cents: format === "currency_cents_usd" }) ?? "—"
  }
  if (format === "percent") {
    const amount = Number(value)
    return Number.isFinite(amount) ? `${amount}%` : "—"
  }
  if (format === "date" || format === "datetime") {
    return formatDateValue(value, { includeTime: format === "datetime" }) ?? "—"
  }
  if (format === "boolean_tri") return formatBooleanTri(value)
  if (format === "enum") return normalizeDisplayString(value) ?? "—"
  if (["url", "email", "phone", "long_text", "text", "string", "prose"].includes(format)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return normalizeDisplayString(value) ?? "—"
    }
    // Graceful coercion for legacy list/object data still stored under text-formatted fields.
    // We never want this branch to log "cannot render object Object" or to throw in strict mode
    // when the underlying value is a perfectly displayable list or key/value bag.
    if (Array.isArray(value)) {
      const joined = value.flatMap((entry) => normalizeStringArrayEntry(entry)).filter(Boolean).join(", ")
      return joined || "—"
    }
    if (value && typeof value === "object") {
      const joined = normalizeStringArrayEntry(value).join(", ")
      return joined || "—"
    }
    // Truly unsupported (functions, symbols, etc.) — warn but don't crash.
    warnMissingMetadata(sectionKey, fieldKey, `format ${format} cannot render ${typeof value}`)
    return "—"
  }
  if (format === "string_array" || format === "tags") {
    // De-dupe + split run-together tokens for display so legacy/intake fields
    // (e.g. keywords) and controlled-vocabulary tag pickers never show repeated,
    // jammed-together values.
    const cleaned = cleanStringArrayForDisplay(value)
    return cleaned.length > 0 ? cleaned.join(", ") : "—"
  }
  if (format === "json") {
    return formatJsonValue(value) ?? "—"
  }

  if (typeof value === "string") return normalizeDisplayString(value) ?? "—"
  warnMissingMetadata(sectionKey, fieldKey, `unsupported format ${format}`)
  return "—"
}
