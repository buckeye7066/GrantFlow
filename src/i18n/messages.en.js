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
  onlyStrongMatches: 'Only strong accepted matches',

  onboardingStep1Title: 'Why we need your profile',
  onboardingStep1Description: 'We use your profile to find funding that may fit and explain the evidence and unknowns.',
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

  // ---------------------------------------------------------------------------
  // guidance — one plain-English coach prompt per page or workflow stage.
  //
  // Consumed by `src/components/guidance/UserStepCoach.jsx`. Each value is
  // either:
  //   { title, description, nextRoute? }                       (static)
  //   ({ profiles, activeProfileId }) =>
  //     { title, description, nextRoute? } | null              (dynamic)
  //
  // `nextRoute` is `{ page, label, params? }`; the coach will render a
  // button that navigates to `createPageUrl(page, params)`.
  //
  // Keep wording warm and short. Anya goal #2: plain language, no jargon.
  // Anya goal #4: every prompt should leave the user knowing the next step.
  // ---------------------------------------------------------------------------
  guidance: {
    Dashboard: {
      title: 'Welcome to your home base',
      description:
        'This page shows the big picture. Start by choosing a profile, then use Find Funding to look for grants that fit.',
      nextRoute: { page: 'MyProfiles', label: 'Choose a profile' },
    },

    MyProfiles: {
      title: 'Profiles tell GrantFlow who we are helping',
      description:
        'Add location, needs, school, health, housing, or nonprofit details. The more complete the profile, the better the matches.',
      nextRoute: { page: 'DiscoverGrants', label: 'Find funding' },
    },

    DiscoverGrants: ({ activeProfileId }) => ({
      title: 'Search for possible funding',
      description:
        activeProfileId && activeProfileId !== '__admin__'
          ? 'GrantFlow will use the selected profile to look for grants, scholarships, help programs, and funding sources that may fit.'
          : 'Choose a profile first. GrantFlow uses that profile to look for grants, scholarships, help programs, and funding sources that may fit.',
      nextRoute: { page: 'FundingResults', label: 'View matches' },
    }),

    FundingResults: {
      title: 'These are possible matches',
      description:
        'Open any funding source that looks useful. Add it to the Pipeline when you want GrantFlow to track it.',
      nextRoute: { page: 'Pipeline', label: 'View pipeline' },
    },

    Pipeline: {
      title: 'This is your work board',
      description:
        'Each card is one funding opportunity. Move cards as the work progresses. Cards marked Portal, Review, or Follow Up usually need a person to act.',
    },

    GrantDetail: {
      title: 'Review this funding source',
      description:
        'Check the deadline, amount, requirements, and application link. If it looks right, follow the next steps or start the proposal.',
    },

    ProfileDetail: {
      title: 'Profile details',
      description:
        'Fill in any missing sections so GrantFlow can match this profile to the right funding sources. You can also jump straight to the pipeline for this profile.',
    },

    Apply: {
      title: 'Prepare this application',
      description:
        'Gather the forms, documents, and answers listed here. GrantFlow has filled in what it can — you finish the rest, then submit.',
    },

    Applications: {
      title: 'Applications in progress',
      description:
        'Every grant you have started, submitted, or are tracking lives here. Open any one to keep working or check status.',
    },

    Documents: {
      title: 'Your documents',
      description:
        'Keep tax IDs, bylaws, budgets, board lists, and other supporting files in one place. Applications can pull from here automatically.',
    },

    GrantDeadline: {
      title: 'Upcoming deadlines',
      description:
        'See every deadline on one calendar so nothing slips. Click any deadline to open the grant.',
    },

    Calendar: {
      title: 'Your calendar',
      description:
        'Deadlines, follow-ups, and key dates from your pipeline show up here. Add reminders so you stay ahead of every cutoff.',
    },

    SavedGrants: {
      title: 'Funding you bookmarked',
      description:
        'Opportunities you saved for later. Add them to your pipeline whenever you are ready to pursue them.',
    },

    Help: {
      title: 'How GrantFlow works',
      description:
        'Quick tours, plain-English explanations, and answers to common questions. Anya can also walk you through anything one step at a time.',
    },

    Settings: {
      title: 'Your settings',
      description:
        'Adjust account preferences, notifications, and integrations here. Changes apply right away.',
    },
  },
}
