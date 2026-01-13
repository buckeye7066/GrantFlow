export const federalAgent = {
  id: 'federal-core',
  jurisdiction: 'Federal',
  state: null,
  administeringAgency: null,
  seedUrls: [
    // CMS / Medicaid / HCBS
    'https://www.medicaid.gov/medicaid/index.html',
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
  ],
  defaultTrack: 'CLIENT',
}

