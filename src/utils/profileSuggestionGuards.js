const LONG_TEXT_FIELDS = new Set(["notes", "personal_statement", "goals", "mission", "needs_description"])
const HOUSEHOLD_EVIDENCE = /\b(dependent child|household (?:member )?receives|parent gets|parent receives|child of|spouse receives)\b/i
const BENEFIT_BASES = ["medicaid", "medicare", "ssi", "ssdi", "snap", "tanf", "section8"]
const OCCUPATION_FLAGS = new Set([
  "healthcare_worker",
  "ems_worker",
  "educator",
  "firefighter",
  "law_enforcement",
  "public_servant",
  "clergy",
  "missionary",
  "nonprofit_employee",
  "small_business_owner",
  "minority_owned_business",
  "women_owned_business",
  "union_member",
  "farmer",
  "truck_driver",
])

function normalizeSentence(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function splitSentences(value) {
  return String(value || "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
}

function jaccard(a, b) {
  const aTokens = new Set(normalizeSentence(a).split(" ").filter(Boolean))
  const bTokens = new Set(normalizeSentence(b).split(" ").filter(Boolean))
  if (aTokens.size === 0 || bTokens.size === 0) return 0
  const intersection = [...aTokens].filter((token) => bTokens.has(token)).length
  const union = new Set([...aTokens, ...bTokens]).size
  return intersection / union
}

export function dedupeLongText(existingValue, suggestionValue, threshold = 0.85) {
  const existingSentences = splitSentences(existingValue)
  const nextSentences = splitSentences(suggestionValue)
  const additions = nextSentences.filter((candidate) =>
    existingSentences.every((existing) => jaccard(existing, candidate) < threshold),
  )
  return [...existingSentences, ...additions].join(" ").trim()
}

function evidenceFor(suggestion, key) {
  const evidence = suggestion?.evidence
  if (evidence && typeof evidence === "object" && evidence[key]) return String(evidence[key])
  return String(suggestion?.[`${key}_evidence`] ?? suggestion?.supporting_evidence ?? suggestion?.evidence_text ?? "")
}

function householdTargetFor(key) {
  for (const base of BENEFIT_BASES) {
    if (key === `${base}_recipient_self` || key === `${base}_recipient`) return `${base}_recipient_household`
    if (base === "medicaid" && key === "medicaid_enrolled") return "medicaid_recipient_household"
    if (base === "section8" && key === "section8_housing") return "section8_recipient_household"
  }
  return null
}

function selfTargetFor(key) {
  if (key === "medicaid_enrolled") return "medicaid_recipient_self"
  if (key === "section8_housing") return "section8_recipient_self"
  if (key.endsWith("_recipient")) return `${key}_self`
  return key
}

function isHighSchoolProfile(profile) {
  const primaryType = String(profile?.primary_type || profile?.primaryType || "").toLowerCase()
  const education = Array.isArray(profile?.sections)
    ? profile.sections.find((section) => section.section_key === "education")?.data
    : profile?.sections?.education
  const highestLevel = String(education?.highest_level || "").toLowerCase()
  return primaryType === "high_school_student" || highestLevel.includes("high_school") || highestLevel.includes("high school")
}

function hasEmployerEvidence(suggestion, key) {
  const evidence = evidenceFor(suggestion, key)
  return /\b(employer|works at|hired by|start(?:ed)? date|since \d{4}|\d{4}-\d{2}-\d{2})\b/i.test(evidence)
}

export function deriveEmploymentStatusForSave(sectionKey, values, profile) {
  if (sectionKey !== "employment") return values
  if (values?.current_status && values?.current_status !== "unknown") return values
  if (isHighSchoolProfile(profile)) return { ...values, current_status: "student" }
  return values
}

export function guardProfileSectionSuggestion(existing, suggestion, { sectionKey, profile } = {}) {
  const guarded = { ...(existing ?? {}) }
  const rejected = []

  for (const [rawKey, rawValue] of Object.entries(suggestion ?? {})) {
    if (rawKey === "evidence" || rawKey.endsWith("_evidence") || rawKey === "supporting_evidence") continue
    let key = selfTargetFor(rawKey)
    let value = rawValue

    if (value === true) {
      const householdTarget = householdTargetFor(rawKey)
      if (householdTarget && HOUSEHOLD_EVIDENCE.test(evidenceFor(suggestion, rawKey))) {
        guarded[householdTarget] = true
        rejected.push({ key: rawKey, reason: "household_evidence", routedTo: householdTarget })
        continue
      }
    }

    if (sectionKey === "occupation" && value === true && OCCUPATION_FLAGS.has(key) && isHighSchoolProfile(profile)) {
      if (!hasEmployerEvidence(suggestion, key)) {
        rejected.push({ key, reason: "missing_employer_evidence" })
        continue
      }
    }

    if (LONG_TEXT_FIELDS.has(key) && typeof value === "string") {
      value = dedupeLongText(guarded[key], value)
    }

    guarded[key] = value
  }

  return { data: guarded, rejected }
}
