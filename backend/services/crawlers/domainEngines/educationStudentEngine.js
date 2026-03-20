/**
 * Education and student funding domain engine. Scholarships, grants, FAFSA, student aid.
 */

import { normalizeAndFilter } from './engineHelper.js'

const ENGINE_ID = 'education_student'

const DIRECTORY_RESOURCES = [
  { title: 'Federal Student Aid', description: 'FAFSA, grants, and federal student aid', url: 'https://studentaid.gov/', categories: ['education'], keywords: ['FAFSA', 'student aid', 'grant'] },
  { title: 'Grants and Scholarships', description: 'StudentAid.gov grants and scholarship info', url: 'https://studentaid.gov/understand-aid/types/grants', categories: ['education'], keywords: ['grant', 'scholarship'] },
  { title: 'College Scorecard', description: 'Compare colleges and financial aid', url: 'https://collegescorecard.ed.gov/', categories: ['education'], keywords: ['college', 'aid'] },
  { title: 'State Higher Ed Agencies', description: 'State-level grants and scholarships', url: 'https://www2.ed.gov/about/contacts/state/index.html', categories: ['education', 'state'], keywords: ['state', 'scholarship'] },
  { title: 'Fastweb Scholarships', description: 'Scholarship search and matching', url: 'https://www.fastweb.com/', categories: ['education'], keywords: ['scholarship'] },
  { title: 'Pell Grants', description: 'Federal Pell Grant program', url: 'https://studentaid.gov/understand-aid/types/grants/pell', categories: ['education'], keywords: ['Pell', 'grant'] },
  { title: 'TEACH Grant', description: 'Teacher education grant for service', url: 'https://studentaid.gov/understand-aid/types/grants/teach', categories: ['education'], keywords: ['TEACH', 'teacher'] },
  { title: 'Iraq and Afghanistan Service Grant', description: 'Grants for children of fallen service members', url: 'https://studentaid.gov/understand-aid/types/grants/iraq-afghanistan', categories: ['education', 'military'], keywords: ['military', 'grant'] },
]

export async function runEducationStudentEngine(profile, options = {}) {
  try {
    return normalizeAndFilter(DIRECTORY_RESOURCES, ENGINE_ID, { strict_no_loans: true, strict_no_matching: false })
  } catch {
    return []
  }
}
