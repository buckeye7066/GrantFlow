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
})

export function buildSchoolLookupFallbackData(schoolName) {
  const known = getKnownSchool(schoolName)
  if (!known) return { ...EMPTY_SCHOOL_LOOKUP_DATA }
  return {
    ...EMPTY_SCHOOL_LOOKUP_DATA,
    fafsaCode: known.fafsaCode || '—',
  }
}
