export const tennesseeAgent = {
  id: 'tn-hhs',
  jurisdiction: 'State',
  state: 'TN',
  administeringAgency: 'Tennessee Department of Human Services / TennCare',
  seedUrls: [
    // TennCare (Medicaid) — canonical URL updated 2024
    'https://www.tn.gov/tenncare',
    // Employment and Community First (ECF) CHOICES (waiver — track A/B linkability)
    'https://www.tn.gov/tenncare/long-term-services-supports',
    'https://www.tn.gov/tenncare/long-term-services-supports/ecf-choices.html',
    // TN DHS — SNAP, TANF, Family Assistance
    'https://www.tn.gov/humanservices/for-families/supplemental-nutrition-assistance-program-snap.html',
    // TN THAP Energy Assistance
    'https://www.tn.gov/humanservices/for-families/community-services-block-grant-csbg/energy-assistance.html',
    // TN Promise scholarship
    'https://www.tn.gov/tnpromise',
  ],
  defaultTrack: 'CLIENT',
}

