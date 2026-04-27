import { SECTION_METADATA } from "@/config/sectionMetadata"

export function isProfileSectionApplicable(sectionKey, profile, metadata = SECTION_METADATA) {
  const config = metadata?.[sectionKey]
  if (!config) return true
  const appliesTo = config.applies_to ?? config.appliesTo ?? null
  if (!Array.isArray(appliesTo) || appliesTo.length === 0) return true

  const primaryType = String(profile?.primary_type ?? profile?.primaryType ?? "").trim()
  if (!primaryType) return false
  return appliesTo.includes(primaryType)
}

export function hasMeaningfulProfileValue(value) {
  if (value === null || value === undefined || value === false) return false
  if (typeof value === "string") return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === "object") {
    return Object.values(value).some(hasMeaningfulProfileValue)
  }
  return true
}

export function getApplicableSectionKeys(profile, metadata = SECTION_METADATA) {
  return Object.keys(metadata || {}).filter((sectionKey) =>
    isProfileSectionApplicable(sectionKey, profile, metadata),
  )
}

export function normalizeProfileSections(sections) {
  if (Array.isArray(sections)) {
    return new Map(
      sections
        .map((section) => [section?.section_key, section])
        .filter(([sectionKey]) => Boolean(sectionKey)),
    )
  }

  if (sections && typeof sections === "object") {
    return new Map(
      Object.entries(sections).map(([sectionKey, data]) => [
        sectionKey,
        { section_key: sectionKey, data },
      ]),
    )
  }

  return new Map()
}

export function calculateProfileCompletion(profile, metadata = SECTION_METADATA) {
  const sectionMap = normalizeProfileSections(profile?.sections)
  const applicableSectionKeys = getApplicableSectionKeys(profile, metadata)

  const completedSectionKeys = applicableSectionKeys.filter((sectionKey) => {
    const section = sectionMap.get(sectionKey)
    const data = section?.data
    if (!data || typeof data !== "object") return false
    return Object.values(data).some(hasMeaningfulProfileValue)
  })

  const totalSections = applicableSectionKeys.length
  const completedSections = completedSectionKeys.length
  const completionPct = totalSections > 0 ? Math.round((completedSections / totalSections) * 100) : 0
  const nextIncompleteSectionKey = applicableSectionKeys.find((sectionKey) => !completedSectionKeys.includes(sectionKey)) ?? null

  return {
    applicableSectionKeys,
    completedSectionKeys,
    totalSections,
    completedSections,
    completionPct,
    nextIncompleteSectionKey,
  }
}
