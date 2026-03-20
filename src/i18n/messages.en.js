/**
 * Centralized user-facing strings for GrantFlow.
 * Use for high-impact page copy; add keys as needed.
 */
export const messages = {
  dashboardHeroHeading: 'Your Dashboard',
  dashboardHeroSubheading: 'Your funding progress at a glance',
  setUpOrganization: 'Get Started',

  discoverGrantsTitle: 'Discover Funding Opportunities',
  discoverGrantsSubtitle: 'Find scholarships, grants, benefits, and assistance programs that match your profile',
  selectProfileToSearch: 'Select Profile to Search',
  chooseProfileDescription: 'Choose a profile so we can search for grants that match you',
  createProfile: 'Create profile',
  searchForFunding: 'Search for Funding',
  findFunding: 'Find Funding',
  pleaseSelectProfileFirst: 'Please select a profile first so we can match grants to your eligibility.',
  createOrEditProfile: 'Create or edit a profile',

  requiresSelectedProfile: 'Requires a selected profile. Choose one above to unlock search.',
  ecfLockedTitle: 'Requires ECF CHOICES profile.',
  ecfLockedDescription: 'Add ECF CHOICES participant or caregiver details to your profile to unlock.',
  ecfHelpTip: 'ECF CHOICES is a Tennessee Medicaid program. Add medicaid_waiver_program = ecf_choices to unlock.',

  minimumMatchScore: 'Minimum match score',
  matchScoreHelp: 'How closely a grant must fit your profile. Lower = more results.',
  matchScoreSubtext: 'Lower this to see more results; raise it for strongest matches only.',

  weFoundNOpportunities: (n) => `We found ${n} opportunities`,
  noSearchResultsYet: 'No search results yet',
  runNewSearch: 'Run a new search',
  noMatchesTryLowering: 'No matches yet—try lowering match score or add ZIP/state.',
  editProfile: 'Edit profile',
  lowerMatchThreshold: 'Lower match threshold',
  whyItMatched: 'Why it matched',
  onlyStrongMatches: 'Only strong matches (≥70%)',

  onboardingStep1Title: 'Why we need your profile',
  onboardingStep1Description: 'We use your profile to match you with funding you qualify for.',
  onboardingStep2Title: 'Tell us a bit about you',
  onboardingStep2Description: 'We need your ZIP and state to find local opportunities.',
  onboardingStep3Title: "You're all set",
  onboardingStep3Description: "We've saved your info. Add more details anytime from My Profiles.",
  lookingFor: 'Looking for',
  lookingForOptions: {
    scholarships: 'Scholarships',
    emergency_help: 'Emergency help',
    disability: 'Disability',
    ministry_nonprofit: 'Ministry / Nonprofit',
    medical: 'Medical',
    general: 'General',
  },
  skipForNow: 'Skip for now',
  confirmAndSave: 'Confirm and save',
  zipCode: 'ZIP Code',
  state: 'State',

  proBonoBannerTitle: 'Important: Pro Bono Status Ending Soon',
  paymentSheet: 'Payment Sheet',
  dismissBanner: 'Dismiss banner',
}
