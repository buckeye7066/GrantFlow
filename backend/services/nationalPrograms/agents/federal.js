export const federalAgent = {
  id: 'federal-core',
  jurisdiction: 'Federal',
  state: null,
  administeringAgency: null,
  seedUrls: [
    // CMS / Medicaid / HCBS (updated paths — /medicaid/index.html redirects as of 2024)
    'https://www.medicaid.gov/',
    'https://www.medicaid.gov/medicaid/waivers/index.html',
    // SSA benefits
    'https://www.ssa.gov/benefits/',
    // HUD housing assistance
    'https://www.hud.gov/topics/rental_assistance',
    // USDA SNAP
    'https://www.fns.usda.gov/snap/supplemental-nutrition-assistance-program',
    // VA benefits
    'https://www.va.gov/health-care/',
    // ACL aging/disability supports
    'https://acl.gov/programs',
    // FEMA individual assistance / disaster relief
    'https://www.disasterassistance.gov/',
    // USDA Rural Development (churches, fire depts, rural orgs)
    'https://www.rd.usda.gov/programs-services/community-facilities',
    // FEMA Grants — AFG, SAFER (fire departments)
    'https://www.fema.gov/grants',
    // ── Broadened REAL national grant/funder index pages ──────────────────
    // HHS grants forecast & program index
    'https://www.hhs.gov/grants/index.html',
    'https://www.grants.gov/search-grants',
    // CDC funding opportunities
    'https://www.cdc.gov/grants/index.html',
    // NIH grants & funding
    'https://grants.nih.gov/grants/guide/index.html',
    'https://grants.nih.gov/funding/index.htm',
    // SAMHSA (behavioral health) grant programs
    'https://www.samhsa.gov/grants',
    // HRSA (rural/health workforce) grants
    'https://www.hrsa.gov/grants',
    // Dept. of Education grant programs (incl. student aid programs)
    'https://www.ed.gov/grants-and-programs',
    'https://studentaid.gov/understand-aid/types/grants',
    // SBA funding programs (grants, not loans — loans are gated out downstream)
    'https://www.sba.gov/funding-programs/grants',
    // AmeriCorps / national service grants
    'https://americorps.gov/funding-opportunities',
    // National scholarship directories (real, federally-affiliated / .gov)
    'https://www.careeronestop.org/Toolkit/Training/find-scholarships.aspx',
  ],
  defaultTrack: 'CLIENT',
}

