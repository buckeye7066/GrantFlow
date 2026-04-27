import { SECTION_METADATA } from "@/config/sectionMetadata"

export const SENTINEL_VALUES = new Set(["", "unknown", "n/a", "none", "null", "undefined"])

const warnedFields = new Set()

function warnMissingMetadata(sectionKey, fieldKey, detail) {
  const key = `${sectionKey || "unknown"}:${fieldKey || "unknown"}:${detail}`
  if (warnedFields.has(key)) return
  warnedFields.add(key)
  const message = `[fieldDisplay] Missing or invalid SECTION_METADATA for profile field ${sectionKey}.${fieldKey}: ${detail}`
  if (import.meta.env?.DEV) throw new Error(message)
  console.warn(message, { sectionKey, fieldKey })
}

export function isSentinelDisplayValue(value) {
  if (value === null || value === undefined) return true
  return SENTINEL_VALUES.has(String(value).trim().toLowerCase())
}

export function normalizeDisplayString(value) {
  if (value === null || value === undefined) return null
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
  warnMissingMetadata(sectionKey, fieldKey, "label")
  return "Unknown field"
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

export function formatFieldValue(sectionKey, fieldKey, value, metadata = SECTION_METADATA) {
  const field = getFieldMetadata(sectionKey, fieldKey, metadata)
  if (!field) {
    warnMissingMetadata(sectionKey, fieldKey, "field")
    return "—"
  }

  const format = field.format ?? "string"
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
  if (["url", "email", "phone", "long_text", "text", "string"].includes(format)) {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      warnMissingMetadata(sectionKey, fieldKey, `format ${format} cannot render ${typeof value}`)
      return "—"
    }
    return normalizeDisplayString(value) ?? "—"
  }
  if (format === "string_array") {
    if (Array.isArray(value)) {
      return value.map(normalizeDisplayString).filter(Boolean).join(", ") || "—"
    }
    if (typeof value === "string") return normalizeDisplayString(value) ?? "—"
    warnMissingMetadata(sectionKey, fieldKey, "string_array value is not an array")
    return "—"
  }
  if (format === "json") {
    if (typeof value === "string") return normalizeDisplayString(value) ?? "—"
    if (Array.isArray(value)) {
      return value
        .map((item) => {
          if (item === null || item === undefined) return null
          if (typeof item !== "object") return normalizeDisplayString(item)
          return Object.entries(item)
            .map(([key, inner]) => `${key}: ${normalizeDisplayString(inner) ?? "—"}`)
            .join(", ")
        })
        .filter(Boolean)
        .join("; ") || "—"
    }
    if (typeof value === "object") {
      return Object.entries(value)
        .map(([key, inner]) => `${key}: ${normalizeDisplayString(inner) ?? "—"}`)
        .join(", ") || "—"
    }
    return normalizeDisplayString(value) ?? "—"
  }

  if (typeof value === "string") return normalizeDisplayString(value) ?? "—"
  warnMissingMetadata(sectionKey, fieldKey, `unsupported format ${format}`)
  return "—"
}
