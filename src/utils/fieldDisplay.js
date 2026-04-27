import { SECTION_METADATA } from "@/config/sectionMetadata"

export const SENTINEL_VALUES = new Set(["", "unknown", "n/a", "none", "null", "undefined"])

const ACRONYMS = new Set([
  "GPA",
  "SAT",
  "ACT",
  "EMS",
  "HIV",
  "AIDS",
  "TBI",
  "SSDI",
  "SSI",
  "SNAP",
  "TANF",
  "IEP",
  "ESL",
  "FAFSA",
  "IRS",
  "EIN",
  "DUNS",
  "UEI",
  "NIH",
  "NSF",
  "DOD",
  "VA",
  "USDA",
  "HHS",
])

const FIELD_LABEL_OVERRIDES = {
  hiv_aids: "HIV/AIDS",
  efc_sai_band: "EFC/SAI Band",
  rotc_jrotc: "ROTC / JROTC",
  is_501c3: "501(c)(3)",
  is_501c3_public_charity: "501(c)(3) Public Charity",
  is_501c3_private_foundation: "501(c)(3) Private Foundation",
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

export function toDisplayTitle(value = "") {
  const normalized = String(value)
    .replace(/([A-Za-z])(\d+)/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()

  return normalized
    .split(" ")
    .map((word) => {
      const cleaned = word.replace(/[^A-Za-z0-9]/g, "")
      const acronym = cleaned.toUpperCase()
      if (ACRONYMS.has(acronym)) return word.replace(cleaned, acronym)
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
    })
    .join(" ")
    .replace(/\bHIV AIDS\b/g, "HIV/AIDS")
}

export function formatFieldLabel(fieldKey, sectionKey, metadata = SECTION_METADATA) {
  if (FIELD_LABEL_OVERRIDES[fieldKey]) return FIELD_LABEL_OVERRIDES[fieldKey]
  const metadataLabel = getFieldMetadata(sectionKey, fieldKey, metadata)?.label
  if (metadataLabel) return metadataLabel
  return toDisplayTitle(fieldKey)
}

export function formatStatusLabel(value) {
  return toDisplayTitle(value)
}
