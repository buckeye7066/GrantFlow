/**
 * Target Colleges Sync Utilities
 * Normalizes education.target_colleges (string or array) and syncs missing colleges
 * into university_applications.applications without duplicates.
 */
import { generateId } from "./generateId.js"

/**
 * Normalize target_colleges to a deduplicated array of trimmed strings.
 * - If array: trim, filter blank, de-dupe case-insensitively
 * - If string: split by comma, trim, filter blank, de-dupe case-insensitively
 * @param {string|string[]|null|undefined} value - Raw value from education section
 * @returns {string[]}
 */
export function normalizeTargetColleges(value) {
  let arr = []
  if (Array.isArray(value)) {
    arr = value.map((v) => (v !== null ? String(v).trim() : "")).filter(Boolean)
  } else if (typeof value === "string") {
    const raw = value.trim()
    if (!raw) return []
    if (raw.startsWith("[")) {
      try {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) {
          arr = parsed.map((v) => (v !== null ? String(v).trim() : "")).filter(Boolean)
        } else {
          arr = raw.split(",").map((s) => s.trim()).filter(Boolean)
        }
      } catch {
        arr = raw.split(",").map((s) => s.trim()).filter(Boolean)
      }
    } else {
      arr = raw.split(",").map((s) => s.trim()).filter(Boolean)
    }
  }
  // Case-insensitive dedupe (keep first occurrence)
  const seen = new Set()
  return arr.filter((name) => {
    const key = name.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Build minimal application object for a college name.
 * @param {string} name - College/university name
 * @returns {object}
 */
export function buildApplicationFromCollegeName(name) {
  return {
    id: generateId("app"),
    name: String(name || "").trim(),
    status: "planning",
    portals: {},
    contacts: [],
    costs: {},
    interests: [],
    activity_catalog: [],
    department_contacts: [],
    financial_aid_pipeline: [],
    local_funding: [],
    institution_type: "university",
  }
}

/**
 * Compute which target college names are missing from existing applications.
 * Uses case-insensitive name comparison.
 * @param {string[]} targetColleges - Normalized list from education.target_colleges
 * @param {object[]} existingApplications - Current university_applications.applications
 * @returns {string[]} College names to add
 */
export function getMissingCollegeNames(targetColleges, existingApplications) {
  if (!targetColleges.length) return []
  const existingNames = new Set(
    (existingApplications || [])
      .map((app) => (app?.name ? String(app.name).trim().toLowerCase() : ""))
      .filter(Boolean),
  )
  return targetColleges.filter((name) => {
    const key = name.toLowerCase()
    return key && !existingNames.has(key)
  })
}

/**
 * Sync target_colleges into university_applications.
 * Only appends missing applications; never overwrites existing.
 * @param {object} educationData - education section data
 * @param {object[]} currentApplications - university_applications.applications
 * @returns {{ applications: object[], addedCount: number }} New applications array and count added
 */
export function syncTargetCollegesToApplications(educationData, currentApplications) {
  const targetColleges = normalizeTargetColleges(educationData?.target_colleges)
  const missing = getMissingCollegeNames(targetColleges, currentApplications ?? [])
  if (missing.length === 0) {
    return {
      applications: Array.isArray(currentApplications) ? [...currentApplications] : [],
      addedCount: 0,
    }
  }
  const newApps = missing.map((name) => buildApplicationFromCollegeName(name))
  const merged = [...(Array.isArray(currentApplications) ? currentApplications : []), ...newApps]
  return { applications: merged, addedCount: newApps.length }
}
