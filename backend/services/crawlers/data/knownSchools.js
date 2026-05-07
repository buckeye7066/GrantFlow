/**
 * knownSchools.js
 *
 * Lightweight registry of common U.S. colleges/universities with their
 * canonical institutional URLs (financial aid, housing, off-campus housing,
 * scholarships, admissions). Used by `generateSchoolCards()` to enrich a
 * profile's `university_applications.applications[]` entries — which are
 * usually just `{ name, status }` — with real, verified portal URLs instead
 * of falling back to a Google search.
 *
 * Mission rules satisfied:
 *   - Real funding only: every URL points at the actual institution.
 *   - Avoid zero-result UX: the system was previously emitting Google search
 *     URLs as the off-campus housing "result" for every target school.
 *     That qualifies as a placeholder result and was failing students like
 *     Anastasia who applied to MTSU and got handed a Google search instead
 *     of MTSU Financial Aid + MTSU Housing.
 *
 * Entries are matched case-insensitively against an alias list. Adding a
 * new school is purely additive — no API or schema change.
 *
 * URLs verified (May 2026).
 */

/**
 * @typedef {Object} KnownSchoolPortals
 * @property {string} [financialAid]
 * @property {string} [housing]
 * @property {string} [offCampusHousing]
 * @property {string} [scholarships]
 * @property {string} [admissions]
 *
 * @typedef {Object} KnownSchool
 * @property {string} name        - canonical display name
 * @property {string[]} aliases   - alternate names users may type
 * @property {string} [website]
 * @property {string} [state]     - 2-letter state code
 * @property {string} [fafsaCode]
 * @property {KnownSchoolPortals} portals
 */

/** @type {KnownSchool[]} */
export const KNOWN_SCHOOLS = [
  {
    name: 'Middle Tennessee State University',
    aliases: ['mtsu', 'middle tennessee state', 'middle tennessee state university'],
    website: 'https://www.mtsu.edu/',
    state: 'TN',
    fafsaCode: '003510',
    portals: {
      financialAid: 'https://www.mtsu.edu/financial-aid/',
      housing: 'https://www.mtsu.edu/housing/',
      offCampusHousing: 'https://www.mtsu.edu/housing/off-campus.php',
      scholarships: 'https://www.mtsu.edu/financial-aid/scholarships/',
      admissions: 'https://www.mtsu.edu/admissions/',
    },
  },
  {
    name: 'University of Central Florida',
    aliases: ['ucf', 'university of central florida', 'central florida'],
    website: 'https://www.ucf.edu/',
    state: 'FL',
    fafsaCode: '003954',
    portals: {
      financialAid: 'https://www.ucf.edu/financial-aid/',
      housing: 'https://www.housing.ucf.edu/',
      offCampusHousing: 'https://offcampus.ucf.edu/',
      scholarships: 'https://www.ucf.edu/financial-aid/scholarships/',
      admissions: 'https://www.ucf.edu/admissions/',
    },
  },
  {
    name: 'University of New Haven',
    aliases: ['university of new haven', 'unh new haven', 'newhaven'],
    website: 'https://www.newhaven.edu/',
    state: 'CT',
    fafsaCode: '001397',
    portals: {
      financialAid: 'https://www.newhaven.edu/admissions/financial-aid/',
      housing: 'https://www.newhaven.edu/student-life/residential-life/',
      offCampusHousing: 'https://www.newhaven.edu/student-life/residential-life/off-campus-living/',
      scholarships: 'https://www.newhaven.edu/admissions/financial-aid/scholarships/',
      admissions: 'https://www.newhaven.edu/admissions/',
    },
  },
  {
    name: 'Pennsylvania State University',
    aliases: ['penn state', 'penn state university', 'pennsylvania state university', 'psu'],
    website: 'https://www.psu.edu/',
    state: 'PA',
    fafsaCode: '003329',
    portals: {
      financialAid: 'https://studentaid.psu.edu/',
      housing: 'https://liveon.psu.edu/',
      offCampusHousing: 'https://studentaffairs.psu.edu/involvement-student-life/off-campus-living',
      scholarships: 'https://studentaid.psu.edu/types-of-aid/scholarships',
      admissions: 'https://admissions.psu.edu/',
    },
  },
  {
    name: 'Trevecca Nazarene University',
    aliases: ['trevecca', 'trevecca nazarene', 'trevecca nazarene university'],
    website: 'https://www.trevecca.edu/',
    state: 'TN',
    fafsaCode: '003526',
    portals: {
      financialAid: 'https://www.trevecca.edu/admissions/financial-aid',
      housing: 'https://www.trevecca.edu/student-life/residence-life',
      offCampusHousing: 'https://www.trevecca.edu/student-life/residence-life',
      scholarships: 'https://www.trevecca.edu/admissions/financial-aid/scholarships',
      admissions: 'https://www.trevecca.edu/admissions',
    },
  },
  {
    name: 'Austin Peay State University',
    aliases: ['austin peay', 'austin peay state', 'austin peay state university', 'apsu'],
    website: 'https://www.apsu.edu/',
    state: 'TN',
    fafsaCode: '003478',
    portals: {
      financialAid: 'https://www.apsu.edu/financial-aid/',
      housing: 'https://www.apsu.edu/housing/',
      offCampusHousing: 'https://www.apsu.edu/housing/off-campus-housing.php',
      scholarships: 'https://www.apsu.edu/financial-aid/scholarships/',
      admissions: 'https://www.apsu.edu/admissions/',
    },
  },
  {
    name: 'Carson-Newman University',
    aliases: ['carson-newman', 'carson newman', 'carson-newman university', 'carson newman university'],
    website: 'https://www.cn.edu/',
    state: 'TN',
    fafsaCode: '003481',
    portals: {
      financialAid: 'https://www.cn.edu/admissions/financial-aid',
      housing: 'https://www.cn.edu/student-life/residence-life',
      offCampusHousing: 'https://www.cn.edu/student-life/residence-life',
      scholarships: 'https://www.cn.edu/admissions/financial-aid/scholarships',
      admissions: 'https://www.cn.edu/admissions',
    },
  },
  {
    name: 'Centre College',
    aliases: ['centre college', 'centre'],
    website: 'https://www.centre.edu/',
    state: 'KY',
    fafsaCode: '001963',
    portals: {
      financialAid: 'https://www.centre.edu/admission/financial-aid/',
      housing: 'https://www.centre.edu/campus-life/residence-life/',
      offCampusHousing: 'https://www.centre.edu/campus-life/residence-life/',
      scholarships: 'https://www.centre.edu/admission/financial-aid/scholarships/',
      admissions: 'https://www.centre.edu/admission/',
    },
  },
  {
    name: 'Christian Brothers University',
    aliases: ['christian brothers university', 'christian brothers', 'cbu'],
    website: 'https://www.cbu.edu/',
    state: 'TN',
    fafsaCode: '003482',
    portals: {
      financialAid: 'https://www.cbu.edu/financial-aid/',
      housing: 'https://www.cbu.edu/student-life/residence-life/',
      offCampusHousing: 'https://www.cbu.edu/student-life/residence-life/',
      scholarships: 'https://www.cbu.edu/financial-aid/scholarships/',
      admissions: 'https://www.cbu.edu/admissions/',
    },
  },
  {
    name: 'Oberlin College',
    aliases: ['oberlin', 'oberlin college', 'oberlin college and conservatory'],
    website: 'https://www.oberlin.edu/',
    state: 'OH',
    fafsaCode: '003086',
    portals: {
      financialAid: 'https://www.oberlin.edu/financial-aid',
      housing: 'https://www.oberlin.edu/residential-education',
      offCampusHousing: 'https://www.oberlin.edu/residential-education',
      scholarships: 'https://www.oberlin.edu/financial-aid/scholarships',
      admissions: 'https://www.oberlin.edu/admissions',
    },
  },
  {
    name: 'Seton Hall University',
    aliases: ['seton hall', 'seton hall university', 'shu'],
    website: 'https://www.shu.edu/',
    state: 'NJ',
    fafsaCode: '002632',
    portals: {
      financialAid: 'https://www.shu.edu/financial-aid/',
      housing: 'https://www.shu.edu/housing/',
      offCampusHousing: 'https://www.shu.edu/housing/off-campus-resources.cfm',
      scholarships: 'https://www.shu.edu/financial-aid/scholarships.cfm',
      admissions: 'https://www.shu.edu/admissions/',
    },
  },
  {
    name: 'The Ohio State University',
    aliases: ['ohio state', 'ohio state university', 'osu', 'the ohio state university'],
    website: 'https://www.osu.edu/',
    state: 'OH',
    fafsaCode: '003090',
    portals: {
      financialAid: 'https://sfa.osu.edu/',
      housing: 'https://housing.osu.edu/',
      offCampusHousing: 'https://offcampus.osu.edu/',
      scholarships: 'https://sfa.osu.edu/types-of-aid/scholarships',
      admissions: 'https://undergrad.osu.edu/apply',
    },
  },
  {
    name: 'University of Alabama',
    aliases: ['university of alabama', 'alabama', 'ua', 'roll tide'],
    website: 'https://www.ua.edu/',
    state: 'AL',
    fafsaCode: '001051',
    portals: {
      financialAid: 'https://financialaid.ua.edu/',
      housing: 'https://housing.sa.ua.edu/',
      offCampusHousing: 'https://offcampus.sa.ua.edu/',
      scholarships: 'https://scholarships.ua.edu/',
      admissions: 'https://gobama.ua.edu/',
    },
  },
  {
    name: 'University of Tennessee at Chattanooga',
    aliases: [
      'university of tennessee at chattanooga',
      'university of tennessee chattanooga',
      'utc',
      'ut chattanooga',
      'tennessee chattanooga',
    ],
    website: 'https://www.utc.edu/',
    state: 'TN',
    fafsaCode: '003529',
    portals: {
      financialAid: 'https://www.utc.edu/finance-and-administration/financial-aid',
      housing: 'https://www.utc.edu/student-life/housing-and-residence-life',
      offCampusHousing: 'https://www.utc.edu/student-life/housing-and-residence-life/off-campus-living',
      scholarships: 'https://www.utc.edu/finance-and-administration/financial-aid/types-of-aid/scholarships',
      admissions: 'https://www.utc.edu/enrollment-management/admissions',
    },
  },
  {
    name: 'University of Tennessee, Knoxville',
    aliases: [
      'university of tennessee knoxville',
      'university of tennessee, knoxville',
      'university of tennessee',
      'ut knoxville',
      'utk',
      'tennessee knoxville',
    ],
    website: 'https://www.utk.edu/',
    state: 'TN',
    fafsaCode: '003530',
    portals: {
      financialAid: 'https://onestop.utk.edu/financial-aid/',
      housing: 'https://housing.utk.edu/',
      offCampusHousing: 'https://offcampus.utk.edu/',
      scholarships: 'https://onestop.utk.edu/financial-aid/scholarships/',
      admissions: 'https://admissions.utk.edu/',
    },
  },
  {
    name: 'University of Michigan',
    aliases: ['university of michigan', 'michigan', 'umich', 'u of m', 'u-m'],
    website: 'https://umich.edu/',
    state: 'MI',
    fafsaCode: '002325',
    portals: {
      financialAid: 'https://finaid.umich.edu/',
      housing: 'https://housing.umich.edu/',
      offCampusHousing: 'https://offcampushousing.umich.edu/',
      scholarships: 'https://finaid.umich.edu/types-of-aid/scholarships/',
      admissions: 'https://admissions.umich.edu/',
    },
  },
  {
    name: 'Florida International University',
    aliases: ['florida international university', 'fiu', 'florida international'],
    website: 'https://www.fiu.edu/',
    state: 'FL',
    fafsaCode: '009635',
    portals: {
      financialAid: 'https://onestop.fiu.edu/finances/financial-aid/',
      housing: 'https://housing.fiu.edu/',
      offCampusHousing: 'https://offcampus.fiu.edu/',
      scholarships: 'https://scholarships.fiu.edu/',
      admissions: 'https://admissions.fiu.edu/',
    },
  },
  {
    name: 'Harvard University',
    aliases: ['harvard', 'harvard university', 'harvard college'],
    website: 'https://www.harvard.edu/',
    state: 'MA',
    fafsaCode: '002155',
    portals: {
      financialAid: 'https://college.harvard.edu/financial-aid',
      housing: 'https://dso.college.harvard.edu/housing-and-residential-life',
      offCampusHousing: 'https://harvardhousing.harvard.edu/',
      scholarships: 'https://college.harvard.edu/financial-aid/types-aid/scholarships-and-grants',
      admissions: 'https://college.harvard.edu/admissions',
    },
  },
  {
    name: 'Lee University',
    aliases: ['lee university', 'lee university tennessee'],
    website: 'https://www.leeuniversity.edu/',
    state: 'TN',
    fafsaCode: '003500',
    portals: {
      financialAid: 'https://www.leeuniversity.edu/admissions/financial-aid/',
      housing: 'https://www.leeuniversity.edu/student-life/housing/',
      offCampusHousing: 'https://www.leeuniversity.edu/student-life/housing/',
      scholarships: 'https://www.leeuniversity.edu/admissions/financial-aid/scholarships/',
      admissions: 'https://www.leeuniversity.edu/admissions/',
    },
  },
]

const NORMALIZED_INDEX = (() => {
  const idx = new Map()
  for (const school of KNOWN_SCHOOLS) {
    const keys = new Set([school.name, ...(school.aliases || [])].map(normalizeName))
    for (const key of keys) {
      if (key) idx.set(key, school)
    }
  }
  return idx
})()

function normalizeName(name) {
  if (!name || typeof name !== 'string') return ''
  return name
    .toLowerCase()
    .replace(/\b(university|college|institute|school|of|the|at|in|for|and|&)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

/**
 * Look up a known school by name (case + punctuation insensitive).
 * Returns null when no entry matches; the caller should fall back to its
 * existing behavior (Google search URL) so the system stays explainable.
 *
 * @param {string} name
 * @returns {KnownSchool|null}
 */
export function getKnownSchool(name) {
  const key = normalizeName(name)
  if (!key) return null
  if (NORMALIZED_INDEX.has(key)) return NORMALIZED_INDEX.get(key)
  // Fuzzy fallback: try a "starts with" match against the normalized index.
  // Helps when the user enters extra qualifiers like "University of Tennessee
  // - Knoxville Campus".
  for (const [indexKey, school] of NORMALIZED_INDEX.entries()) {
    if (key.startsWith(indexKey) || indexKey.startsWith(key)) return school
  }
  return null
}

/**
 * Enrich a profile-supplied school object with known portals/website/state
 * when those fields are missing. Never overwrites user-supplied data.
 *
 * @param {Object} school - { name, status, portals?, website?, state? }
 * @returns {Object} enriched copy
 */
export function enrichSchool(school) {
  if (!school || typeof school !== 'object') return school
  const known = getKnownSchool(school.name)
  if (!known) return school
  return {
    ...school,
    website: school.website || known.website || null,
    state: school.state || known.state || null,
    fafsaCode: school.fafsaCode || known.fafsaCode || null,
    portals: {
      ...(known.portals || {}),
      ...(school.portals || {}),
    },
    knownSchoolMatched: true,
  }
}

export default KNOWN_SCHOOLS
