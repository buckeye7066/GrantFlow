import { SECTION_METADATA } from "@/config/sectionMetadata"
import { isSentinelDisplayValue } from "@/utils/fieldDisplay"
import { sectionAppliesToProfileType } from "../../shared/profileSectionApplicability.js"

export function isProfileSectionApplicable(sectionKey, profile, metadata = SECTION_METADATA) {
  const config = metadata?.[sectionKey]
  if (!config) return true
  return sectionAppliesToProfileType(config, profile)
}

export function hasMeaningfulProfileValue(value) {
  if (value === null || value === undefined || value === false) return false
  if (typeof value === "string") return !isSentinelDisplayValue(value)
  if (Array.isArray(value)) return value.some(hasMeaningfulProfileValue)
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
