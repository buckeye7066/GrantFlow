import { getKnownSchool } from './crawlers/data/knownSchools.js'

export const EMPTY_SCHOOL_LOOKUP_DATA = Object.freeze({
  acceptanceRate: '—',
  avgGPA: '—',
  satRange: '—',
  tuition: '—',
  fafsaCode: '—',
  graduationRate: '—',
  studentTeacher: '—',
  avgClassSize: '—',
  estCost: '—',
  enrollment: '—',
  founded: '—',
  type: '—',
  setting: '—',
  // Extended fields the AI assist now also populates for school cards.
  // Portal URLs power the per-school quick-link buttons, theme colors paint
  // the school header so each card visually represents the school, and
  // mascot / cheerLine drive the small cheer chip the parent UI shows.
  websiteUrl: '—',
  admissionsUrl: '—',
  financialAidUrl: '—',
  scholarshipsUrl: '—',
  housingUrl: '—',
  studentPortalUrl: '—',
  primaryColor: '—',
  secondaryColor: '—',
  mascot: '—',
  cheerLine: '—',
})

export function buildSchoolLookupFallbackData(schoolName) {
  const known = getKnownSchool(schoolName)
  if (!known) return { ...EMPTY_SCHOOL_LOOKUP_DATA }
  // Reuse the canonical portal URLs we already vetted for known schools so
  // the AI-assist fallback path emits real URLs (not "—") even when the
  // OpenAI/Anthropic providers are unreachable. Mission rule: avoid placeholder
  // results when real data exists.
  const portals = known.portals || {}
  const theme = known.theme || {}
  return {
    ...EMPTY_SCHOOL_LOOKUP_DATA,
    fafsaCode: known.fafsaCode || '—',
    websiteUrl: known.website || '—',
    admissionsUrl: portals.admissions || '—',
    financialAidUrl: portals.financialAid || '—',
    scholarshipsUrl: portals.scholarships || '—',
    housingUrl: portals.housing || portals.offCampusHousing || '—',
    studentPortalUrl: portals.studentPortal || portals.admissions || '—',
    primaryColor: theme.primaryColor || '—',
    secondaryColor: theme.secondaryColor || '—',
    mascot: theme.mascot || '—',
    cheerLine: theme.cheerLine || '—',
  }
}
