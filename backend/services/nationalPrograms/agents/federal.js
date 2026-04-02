export const federalAgent = {
  id: 'federal-core',
  jurisdiction: 'Federal',
  state: null,
  administeringAgency: null,
  // Declare the need categories this agent's programs address so the crawler
  // can tag harvested records before they reach the decision engine.
  // Aligns with profileHelpers.js need category normalisation.
  needCategories: [
    'medical',        // Medicaid / Medicare / HCBS
    'disability',     // SSA SSDI/SSI, ACL waiver programs
    'housing',        // HUD rental assistance, Section 8
    'food',           // USDA SNAP
    'veterans',       // VA health care, disability comp
    'caregiving',     // ACL caregiver support programs
    'aging',          // ACL Older Americans Act programs
  ],
  seedUrls: [
    // CMS / Medicaid / HCBS â state-specific application portals, not hub pages
    'https://www.medicaid.gov/medicaid/waivers/index.html',
    // SSA benefits â application entry point
    'https://www.ssa.gov/benefits/disability/',
    'https://www.ssa.gov/applyonline/',
    // HUD housing assistance â application-facing resource locator
    'https://www.hud.gov/program_offices/public_indian_housing/programs/hcv/about',
    'https://www.hudexchange.info/programs/',
    // USDA SNAP â state agency locator (actual application path)
    'https://www.fns.usda.gov/snap/state-directory',
    // VA benefits â apply landing page
    'https://www.va.gov/health-care/apply-for-health-care-form-10-10ez/',
    // ACL aging/disability â Eldercare locator (produces application-path contacts)
    'https://eldercare.acl.gov/Public/Index.aspx',
  ],
  // Require crawler to surface an application URL before inserting any record
  requireApplicationUrl: true,
  // Hints for the crawler to identify apply-path links vs informational links
  applyLinkPatterns: [
    /apply/i,
    /application/i,
    /enroll/i,
    /register/i,
    /portal/i,
    /form/i,
  ],
  defaultTrack: 'CLIENT',
}

