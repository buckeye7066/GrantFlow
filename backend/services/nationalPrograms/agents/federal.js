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
  ],
  defaultTrack: 'CLIENT',
}

