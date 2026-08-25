/**
 * Canonical Help Registry — single source of truth for all page descriptions,
 * field explanations, tour steps, and Anya app knowledge.
 *
 * Consumed by: Help page, AnyaGuidedTour, anyaHelpKnowledge (backend).
 *
 * For profile section titles, descriptions, and field-level metadata, see:
 * @see src/config/sectionMetadata.js
 */

export const CURRENT_TOUR_VERSION = 1
export const CURRENT_MANUAL_VERSION = 1

/**
 * Full registry of every page / nav item with descriptions, purposes, actions, and field data.
 * Keys must match routeName values from src/nav/navConfig.js.
 */
export const HELP_REGISTRY = [
  // ── Home ──────────────────────────────────────────────────────────────────
  {
    key: 'Dashboard',
    route: '/Dashboard',
    navGroup: 'home',
    title: 'Dashboard',
    description: 'Your home base: overview of grants, deadlines, and activity. Jump back here anytime.',
    purpose: 'Get a snapshot of your grant pipeline, upcoming deadlines, and recent activity in one place.',
    whoCanUse: 'all',
    mainActions: ['View grant pipeline summary', 'Check upcoming deadlines', 'Access quick links to common tasks'],
    relatedFeatures: ['Calendar', 'Pipeline', 'GrantDeadline'],
    affectsMatching: false,
    fields: [],
  },
  {
    key: 'Calendar',
    route: '/Calendar',
    navGroup: 'home',
    title: 'Calendar',
    description: 'See grant deadlines and key dates in a calendar view.',
    purpose: 'Visualise all grant deadlines and activity on a monthly/weekly calendar so nothing slips through.',
    whoCanUse: 'all',
    mainActions: ['Browse deadlines by month', 'Navigate to grant detail from calendar event'],
    relatedFeatures: ['Dashboard', 'GrantDeadline'],
    affectsMatching: false,
    fields: [],
  },

  // ── Help ──────────────────────────────────────────────────────────────────
  {
    key: 'Help',
    route: '/Help',
    navGroup: 'help',
    title: 'Help Center',
    description: 'Guides, FAQs, and documentation to help you get the most out of GrantFlow.',
    purpose: 'Find answers to common questions, understand each feature, and get step-by-step guidance.',
    whoCanUse: 'all',
    mainActions: ['Search help topics', 'Browse FAQs', 'Contact support'],
    relatedFeatures: ['Dashboard'],
    affectsMatching: false,
    fields: [],
  },

  // ── Setup ─────────────────────────────────────────────────────────────────
  {
    key: 'MyProfiles',
    route: '/MyProfiles',
    navGroup: 'setup',
    title: 'My Profiles',
    description: 'Manage your organization profiles — the entities you apply for grants as.',
    purpose: 'Profiles store all the information GrantFlow uses to match you to funding opportunities. Each profile represents a distinct applicant (individual, nonprofit, business, etc.).',
    whoCanUse: 'all',
    mainActions: ['Create a new profile', 'Edit existing profiles', 'Switch active profile', 'Complete profile sections for better matches'],
    relatedFeatures: ['SmartMatcher', 'ProfileMatcher', 'Organizations'],
    affectsMatching: true,
    fields: [
      {
        key: 'zip',
        label: 'ZIP Code',
        explanation: 'Your 5-digit US postal code.',
        whyItMatters: 'Determines which local, county, and state funding opportunities appear in your results. Many grants are restricted to specific zip codes or counties.',
        affectsMatching: true,
        affectsCrawlers: true,
        required: true,
        example: '37201',
      },
      {
        key: 'state',
        label: 'State',
        explanation: 'The US state your organization or household is located in.',
        whyItMatters: 'State-specific grants and programs are filtered by this field. Setting it correctly ensures state government and foundation grants appear.',
        affectsMatching: true,
        affectsCrawlers: true,
        required: true,
        example: 'Tennessee',
      },
      {
        key: 'entity_type',
        label: 'Entity / Applicant Type',
        explanation: 'Whether you are applying as an individual, nonprofit, small business, government agency, or other entity type.',
        whyItMatters: 'Most grants restrict eligibility to specific entity types. This is the primary filter for match eligibility.',
        affectsMatching: true,
        affectsCrawlers: true,
        required: true,
        example: 'nonprofit',
      },
      {
        key: 'naics_codes',
        label: 'NAICS Industry Codes',
        explanation: 'North American Industry Classification System codes describing your industry sector.',
        whyItMatters: 'Industry-specific grants, SBA programs, and federal opportunities filter by NAICS code. Adding accurate codes unlocks sector-specific funding.',
        affectsMatching: true,
        affectsCrawlers: true,
        required: false,
        example: '541611 (Management Consulting)',
      },
      {
        key: 'revenue',
        label: 'Annual Revenue',
        explanation: 'Your organization\'s or household\'s approximate annual revenue or income.',
        whyItMatters: 'Income thresholds determine eligibility for many need-based grants and programs. Low-income or small-revenue status unlocks additional opportunities.',
        affectsMatching: true,
        affectsCrawlers: false,
        required: false,
        example: '$250,000',
      },
      {
        key: 'full_name',
        label: 'Full / Legal Name',
        explanation: 'Your legal name or the legal name of your organization.',
        whyItMatters: 'Used to pre-fill applications and proposals. Required for printable applications.',
        affectsMatching: false,
        affectsCrawlers: false,
        required: false,
        example: 'Community Uplift Foundation, Inc.',
      },
      {
        key: 'display_name',
        label: 'Display Name',
        explanation: 'The short name shown throughout the GrantFlow interface.',
        whyItMatters: 'Used in the profile selector and pipeline views. Does not affect matching.',
        affectsMatching: false,
        affectsCrawlers: false,
        required: false,
        example: 'Community Uplift',
      },
      {
        key: 'looking_for',
        label: 'What Are You Looking For?',
        explanation: 'A brief description of your primary funding goals.',
        whyItMatters: 'Helps Smart Matcher prioritise search strategies and tailor AI matching to your stated goals.',
        affectsMatching: true,
        affectsCrawlers: true,
        required: false,
        example: 'Funding for after-school programs for at-risk youth',
      },
      {
        key: 'health_conditions',
        label: 'Health Conditions',
        explanation: 'Chronic illnesses, disabilities, or medical conditions that apply to you or your household.',
        whyItMatters: 'Health-condition grants, disease-specific foundations, and medical assistance programs match on this data. Required to see medical/disability grants.',
        affectsMatching: true,
        affectsCrawlers: true,
        required: false,
        example: 'Type 2 Diabetes, Hearing Impairment',
      },
      {
        key: 'financial_details',
        label: 'Financial Details',
        explanation: 'Household income, assets, poverty level status, and other financial indicators.',
        whyItMatters: 'Need-based grants, utility assistance, housing programs, and emergency funds filter heavily on financial data.',
        affectsMatching: true,
        affectsCrawlers: true,
        required: false,
        example: 'Below 200% federal poverty level',
      },
      {
        key: 'education',
        label: 'Education Level',
        explanation: 'Your highest level of educational attainment.',
        whyItMatters: 'Education grants, scholarships, and workforce development programs filter by education level.',
        affectsMatching: true,
        affectsCrawlers: true,
        required: false,
        example: 'High School Diploma / GED',
      },
      {
        key: 'military_status',
        label: 'Military / Veteran Status',
        explanation: 'Whether you or someone in your household is an active military member, veteran, or military dependent.',
        whyItMatters: 'Veteran-specific grants, VA programs, and military family benefits require this flag to surface.',
        affectsMatching: true,
        affectsCrawlers: true,
        required: false,
        example: 'Veteran (Army, honorable discharge)',
      },
      {
        key: 'government_assistance',
        label: 'Government Assistance Programs',
        explanation: 'Any government programs you currently receive (SNAP, Medicaid, WIC, SSI, etc.).',
        whyItMatters: 'Many supplemental programs require or prefer applicants already enrolled in base programs. This unlocks categorical eligibility pathways.',
        affectsMatching: true,
        affectsCrawlers: true,
        required: false,
        example: 'SNAP, Medicaid',
      },
      {
        key: 'family_composition',
        label: 'Family Composition',
        explanation: 'Household size, presence of children, elderly members, or individuals with disabilities.',
        whyItMatters: 'Family-specific grants, childcare assistance, elder care programs, and per-capita income calculations depend on household composition.',
        affectsMatching: true,
        affectsCrawlers: true,
        required: false,
        example: 'Single parent, 2 children under 12',
      },
    ],
  },
  {
    key: 'Organizations',
    route: '/Organizations',
    navGroup: 'setup',
    title: 'Organizations',
    description: 'View and manage organizations linked to your account.',
    purpose: 'Organizations are the top-level legal entities. Profiles belong to organizations. Manage tax IDs, addresses, and org-level details here.',
    whoCanUse: 'all',
    mainActions: ['Create a new organization', 'Edit organization details', 'Link profiles to an organization'],
    relatedFeatures: ['MyProfiles'],
    affectsMatching: false,
    fields: [],
  },
  {
    key: 'Settings',
    route: '/Settings',
    navGroup: 'setup',
    title: 'Settings',
    description: 'Account preferences, notifications, and general app settings.',
    purpose: 'Customise your GrantFlow experience: notification preferences, theme, email, and security settings.',
    whoCanUse: 'all',
    mainActions: ['Update email or password', 'Set notification preferences', 'Change display preferences'],
    relatedFeatures: ['MyProfiles'],
    affectsMatching: false,
    fields: [],
  },

  // ── Find Funding ──────────────────────────────────────────────────────────
  {
    key: 'DiscoverGrants',
    route: '/DiscoverGrants',
    navGroup: 'find',
    title: 'Discover Grants',
    description: 'Search and discover funding opportunities. Run crawlers and browse results.',
    purpose: 'Actively search for new grants by keyword, category, or geography. Trigger crawlers to find fresh opportunities across all sources.',
    whoCanUse: 'all',
    mainActions: ['Search by keyword', 'Filter by type or geography', 'Add opportunities to pipeline'],
    relatedFeatures: ['FundingResults', 'SmartMatcher', 'DataSources'],
    affectsMatching: false,
    fields: [],
  },
  {
    key: 'FundingResults',
    route: '/FundingResults',
    navGroup: 'find',
    title: 'Funding Results',
    description: 'Browse all funding opportunities in one place. Filter and sort.',
    purpose: 'Review all crawled and matched funding results. Apply advanced filters to narrow down the list to your best-fit opportunities.',
    whoCanUse: 'all',
    mainActions: ['Filter by score, type, deadline', 'Sort by relevance or deadline', 'Add to pipeline'],
    relatedFeatures: ['DiscoverGrants', 'SmartMatcher', 'Pipeline'],
    affectsMatching: false,
    fields: [],
  },
  {
    key: 'SmartMatcher',
    route: '/SmartMatcher',
    navGroup: 'find',
    title: 'Smart Matcher',
    description:
      'AI-powered matching: find grants that fit your profile. Describe what you need in plain language or use keywords.',
    purpose:
      'Uses your complete profile data to run intelligent matching across all known funding sources. The Describe what you need box plus Understand & search turns a sentence (for example bereavement travel or a passenger van) into catalog search terms; several terms are searched together so related programs are easier to find. The more complete your profile, the better the matches.',
    whoCanUse: 'all',
    mainActions: [
      'Describe your need in plain language (Understand & search)',
      'Run Smart Match for active profile',
      'View match scores and explanations',
      'Add top matches to pipeline',
    ],
    relatedFeatures: ['ProfileMatcher', 'FundingResults', 'MyProfiles'],
    affectsMatching: true,
    fields: [],
  },
  {
    key: 'ProfileMatcher',
    route: '/ProfileMatcher',
    navGroup: 'find',
    title: 'Profile Matcher',
    description: 'Match your profile against funding criteria to see fit scores.',
    purpose: 'Deep-dive into how a specific profile matches against a specific opportunity. Understand why you do or don\'t qualify and what would improve your score.',
    whoCanUse: 'all',
    mainActions: ['Select a profile and an opportunity', 'View detailed eligibility breakdown', 'Identify profile gaps'],
    relatedFeatures: ['SmartMatcher', 'MyProfiles'],
    affectsMatching: true,
    fields: [],
  },
  {
    key: 'FundingOpportunities',
    route: '/FundingOpportunities',
    navGroup: 'find',
    title: 'Funding Opportunities',
    description: 'Browse all funding opportunities from every source in one searchable list.',
    purpose: 'Comprehensive catalogue of all funding opportunities across all sources. Different from Funding Results in that it shows the raw catalogue, not just profile-matched results.',
    whoCanUse: 'all',
    mainActions: ['Browse catalogue', 'Filter by type, source, or amount', 'View opportunity details'],
    relatedFeatures: ['DataSources', 'DiscoverGrants'],
    affectsMatching: false,
    fields: [],
  },
  {
    key: 'Funder',
    route: '/Funder',
    navGroup: 'find',
    title: 'Funder',
    description: 'Explore funders and their grant programs.',
    purpose: 'Research funding organizations — foundations, government agencies, and corporations — and understand their focus areas and giving history.',
    whoCanUse: 'all',
    mainActions: ['Browse funders by type or focus', 'View a funder\'s active programs', 'Add funder opportunities to pipeline'],
    relatedFeatures: ['FundingOpportunities', 'Pipeline'],
    affectsMatching: false,
    fields: [],
  },
  {
    key: 'DataSources',
    route: '/DataSources',
    navGroup: 'find',
    title: 'Data Sources',
    description: 'Manage external data sources that feed grant information into GrantFlow.',
    purpose: 'View and manage which data sources are active, when they were last crawled, and their status. Add new sources or trigger manual refreshes.',
    whoCanUse: 'all',
    mainActions: ['View source status', 'Trigger source refresh', 'Add new data source'],
    relatedFeatures: ['SourceDirectory', 'DiscoverGrants'],
    affectsMatching: false,
    fields: [],
  },
  {
    key: 'SourceDirectory',
    route: '/SourceDirectory',
    navGroup: 'find',
    title: 'Source Directory',
    description: 'Browse the directory of funding sources and APIs.',
    purpose: 'A curated directory of all known funding sources — government portals, foundations, and aggregators. Useful for discovering new sources to add.',
    whoCanUse: 'all',
    mainActions: ['Browse source directory', 'View source details', 'Enable a source'],
    relatedFeatures: ['DataSources'],
    affectsMatching: false,
    fields: [],
  },
  {
    key: 'NOFOParser',
    route: '/NOFOParser',
    navGroup: 'find',
    title: 'NOFO Parser',
    description: 'Parse Notice of Funding Opportunity (NOFO) documents for structured data.',
    purpose: 'Upload or paste a NOFO document and let AI extract key details: eligibility, deadlines, funding amounts, requirements, and application instructions.',
    whoCanUse: 'advanced',
    mainActions: ['Upload a NOFO PDF or paste text', 'Extract structured grant data', 'Add parsed opportunity to pipeline'],
    relatedFeatures: ['AIGrantScorer', 'Pipeline'],
    affectsMatching: false,
    fields: [],
  },
  {
    key: 'AIGrantScorer',
    route: '/AIGrantScorer',
    navGroup: 'find',
    title: 'AI Grant Scorer',
    description: 'Score grants with AI to prioritise which to pursue.',
    purpose: 'Use AI to rapidly evaluate a list of opportunities and rank them by likelihood of success given your profile and capacity.',
    whoCanUse: 'advanced',
    mainActions: ['Upload grant list or paste descriptions', 'Get AI-generated priority scores', 'Export ranked list'],
    relatedFeatures: ['NOFOParser', 'SmartMatcher'],
    affectsMatching: false,
    fields: [],
  },

  // ── Work ──────────────────────────────────────────────────────────────────
  {
    key: 'Pipeline',
    route: '/Pipeline',
    navGroup: 'work',
    title: 'Pipeline',
    description: 'Your grant pipeline: track applications from discovery to submission.',
    purpose: 'Manage every grant opportunity you\'re actively pursuing. Move them through stages: Discovered → Interested → Drafting → Submitted → Won/Lost.',
    whoCanUse: 'all',
    mainActions: ['Add opportunities to pipeline', 'Update application stage', 'View upcoming deadlines', 'Track submission history'],
    relatedFeatures: ['Proposals', 'Documents', 'GrantDeadline'],
    affectsMatching: false,
    fields: [],
  },
  {
    key: 'Proposals',
    route: '/Proposals',
    navGroup: 'work',
    title: 'Proposals',
    description: 'Manage proposals and application drafts.',
    purpose: 'Create and manage grant proposal documents, draft narratives, budgets, and letters of intent. Linked to pipeline items.',
    whoCanUse: 'all',
    mainActions: ['Create a new proposal', 'Draft needs statement or narrative', 'Link proposal to pipeline item'],
    relatedFeatures: ['Pipeline', 'Documents'],
    affectsMatching: false,
    fields: [],
  },
  {
    key: 'Documents',
    route: '/Documents',
    navGroup: 'work',
    title: 'Documents',
    description: 'Upload, store, and organise application documents.',
    purpose: 'Central document repository for all grant-related files: financial statements, letters of support, IRS determination letters, and other attachments.',
    whoCanUse: 'all',
    mainActions: ['Upload documents', 'Organise by tag or pipeline item', 'Share or download files'],
    relatedFeatures: ['Proposals', 'Pipeline'],
    affectsMatching: false,
    fields: [],
  },
  {
    key: 'PrintableApplication',
    route: '/PrintableApplication',
    navGroup: 'work',
    title: 'Printable Application',
    description: 'Generate a printable version of an application for offline work.',
    purpose: 'Create a print-ready PDF or formatted document combining all application components. Useful for offline completion, recordkeeping, or mailing to funders.',
    whoCanUse: 'all',
    mainActions: ['Select pipeline item', 'Generate printable packet', 'Download or print PDF'],
    relatedFeatures: ['Proposals', 'Documents'],
    affectsMatching: false,
    fields: [],
  },

  // ── Track & Report ────────────────────────────────────────────────────────
  {
    key: 'GrantDeadline',
    route: '/GrantDeadline',
    navGroup: 'track',
    title: 'Grant Deadline',
    description: 'Track upcoming grant deadlines so you never miss one.',
    purpose: 'A focused view of all approaching deadlines across your pipeline. Shows days remaining and priority level.',
    whoCanUse: 'all',
    mainActions: ['View deadline list sorted by urgency', 'Set deadline reminders', 'Link deadline to pipeline item'],
    relatedFeatures: ['Calendar', 'Pipeline'],
    affectsMatching: false,
    fields: [],
  },
  {
    key: 'GrantMonitoring',
    route: '/GrantMonitoring',
    navGroup: 'track',
    title: 'Grant Monitoring',
    description: 'Monitor grant status and follow up on submissions.',
    purpose: 'Track the status of submitted applications, log funder communications, and manage post-award reporting requirements.',
    whoCanUse: 'all',
    mainActions: ['Update grant status', 'Log funder contact', 'Set follow-up reminders'],
    relatedFeatures: ['Pipeline'],
    affectsMatching: false,
    fields: [],
  },
  {
    key: 'Reports',
    route: '/Reports',
    navGroup: 'track',
    title: 'Reports & Analytics',
    description: 'Reports and analytics on your grant activity.',
    purpose: 'Generate summary reports on grant applications, success rates, funding received, and pipeline health. Export to PDF or CSV.',
    whoCanUse: 'all',
    mainActions: ['Generate activity report', 'View success rate metrics', 'Export data'],
    relatedFeatures: ['AdvancedAnalytics', 'Pipeline'],
    affectsMatching: false,
    fields: [],
  },
  {
    key: 'AdvancedAnalytics',
    route: '/AdvancedAnalytics',
    navGroup: 'track',
    title: 'Advanced Analytics',
    description: 'Deep-dive analytics and visualisations for power users.',
    purpose: 'Interactive charts and trend analysis of your grant outcomes, match quality over time, and funding pipeline performance.',
    whoCanUse: 'advanced',
    mainActions: ['Explore match score trends', 'Analyse pipeline velocity', 'Compare periods'],
    relatedFeatures: ['Reports'],
    affectsMatching: false,
    fields: [],
  },
  {
    key: 'Outreach',
    route: '/Outreach',
    navGroup: 'track',
    title: 'Outreach',
    description: 'Manage outreach to funders and partners.',
    purpose: 'Log and track all funder communications — emails, calls, meetings — linked to specific grant opportunities.',
    whoCanUse: 'all',
    mainActions: ['Log a funder contact', 'View outreach history', 'Schedule follow-ups'],
    relatedFeatures: ['Pipeline'],
    affectsMatching: false,
    fields: [],
  },
  // ── Admin / Operations ────────────────────────────────────────────────────
  {
    key: 'Automation',
    route: '/Automation',
    navGroup: 'admin',
    title: 'Automation',
    description: 'Configure automated workflows and crawler schedules.',
    purpose: 'Set up recurring crawl schedules, automated grant matching triggers, and workflow automations that run in the background.',
    whoCanUse: 'all',
    mainActions: ['Schedule crawler runs', 'Configure automation triggers', 'View automation logs'],
    relatedFeatures: ['DataSources', 'DiscoverGrants'],
    affectsMatching: false,
    fields: [],
  },
  {
    key: 'Billing',
    route: '/Billing',
    navGroup: 'admin',
    title: 'Billing & Invoicing',
    description: 'Billing, invoicing, and subscription management.',
    purpose: 'Manage your GrantFlow subscription, view invoices, update payment methods, and track usage.',
    whoCanUse: 'all',
    mainActions: ['View subscription plan', 'Download invoices', 'Update payment method'],
    relatedFeatures: ['Settings'],
    affectsMatching: false,
    fields: [],
  },
  {
    key: 'Budgets',
    route: '/Budgets',
    navGroup: 'admin',
    title: 'Budgets',
    description: 'Manage budgets and expense tracking for grants.',
    purpose: 'Create and track grant budgets, monitor spend against awards, and generate budget reports for compliance.',
    whoCanUse: 'all',
    mainActions: ['Create a budget', 'Track expenses against budget', 'Generate budget report'],
    relatedFeatures: ['Pipeline', 'Reports'],
    affectsMatching: false,
    fields: [],
  },
  {
    key: 'Diagnostics',
    route: '/Diagnostics',
    navGroup: 'admin',
    title: 'Diagnostics',
    description: 'System diagnostics and troubleshooting tools.',
    purpose: 'View system health, check crawler status, inspect database statistics, and diagnose issues with the GrantFlow platform.',
    whoCanUse: 'all',
    mainActions: ['View system health', 'Check crawler job queue', 'Inspect database stats'],
    relatedFeatures: ['DataSources', 'Automation'],
    affectsMatching: false,
    fields: [],
  },
  {
    key: 'Admin',
    route: '/Admin',
    navGroup: 'admin',
    title: 'Admin Panel',
    description: 'Admin panel for system configuration and user management.',
    purpose: 'Full system administration: manage users, profiles, organizations, API keys, crawler configuration, and system-wide settings.',
    whoCanUse: 'admin',
    mainActions: ['Manage users and roles', 'Configure system settings', 'View audit logs', 'Manage API keys'],
    relatedFeatures: ['Diagnostics', 'Automation'],
    affectsMatching: false,
    fields: [],
  },
  {
    key: 'Incognito',
    route: '/Incognito',
    navGroup: 'admin',
    title: 'Incognito',
    description: 'Privacy mode: remove sensitive data before sharing screenshots or exports.',
    purpose: 'Temporarily mask sensitive profile data (names, addresses, financial figures) when sharing your screen or exporting reports.',
    whoCanUse: 'privacy',
    mainActions: ['Enable incognito mask', 'Adjust which fields are masked', 'Export masked report'],
    relatedFeatures: ['Settings'],
    affectsMatching: false,
    fields: [],
  },
]

// ── Helper functions ──────────────────────────────────────────────────────────

/**
 * Look up a registry entry by routeName key.
 * @param {string} routeName
 * @returns {object|undefined}
 */
export function getHelpForRoute(routeName) {
  return HELP_REGISTRY.find((entry) => entry.key === routeName)
}

/**
 * Look up a field definition by its key across all registry entries.
 * @param {string} fieldKey
 * @returns {{ field: object, page: object }|undefined}
 */
export function getHelpForField(fieldKey) {
  for (const entry of HELP_REGISTRY) {
    const field = entry.fields?.find((f) => f.key === fieldKey)
    if (field) return { field, page: entry }
  }
  return undefined
}

/**
 * Return tour steps appropriate for the user's role.
 * Steps are a subset of HELP_REGISTRY entries formatted for the tour UI.
 * Defensive defaults are provided so that missing/undefined registry properties
 * never produce malformed tour steps.
 * @param {'user'|'admin'} role
 * @returns {Array<{ key: string, route: string, title: string, description: string, purpose: string, navGroup: string, mainActions: string[] }>}
 */
export function getTourStepsForRole(role) {
  const coreKeys = ['Dashboard', 'MyProfiles', 'SmartMatcher', 'Pipeline', 'GrantDeadline', 'Help']
  const adminKeys = ['Admin', 'Diagnostics', 'Automation']

  const keys = role === 'admin' ? [...coreKeys, ...adminKeys] : coreKeys

  return keys
    .map((key) => HELP_REGISTRY.find((e) => e.key === key))
    .filter(Boolean)
    .map((entry) => ({
      key: entry.key,
      route: entry.route ?? '',
      title: entry.title ?? '',
      description: entry.description ?? '',
      purpose: entry.purpose ?? '',
      navGroup: entry.navGroup ?? '',
      mainActions: Array.isArray(entry.mainActions) ? entry.mainActions : [],
    }))
}

/**
 * Full-text search across the help registry.
 * Searches title, description, purpose, mainActions, navGroup, and field
 * labels/explanations/whyItMatters. Each field is checked individually and the
 * search short-circuits as soon as a match is found, avoiding building a large
 * combined string per entry.
 * @param {string} query
 * @returns {Array<object>}
 */
export function searchHelpRegistry(query) {
  if (!query || !query.trim()) return HELP_REGISTRY
  const q = query.trim().toLowerCase()

  const matches = (value) =>
    typeof value === 'string' && value.toLowerCase().includes(q)

  return HELP_REGISTRY.filter((entry) => {
    if (matches(entry.title)) return true
    if (matches(entry.description)) return true
    if (matches(entry.purpose)) return true
    if (matches(entry.navGroup)) return true

    if (Array.isArray(entry.mainActions)) {
      for (const action of entry.mainActions) {
        if (matches(action)) return true
      }
    }

    if (Array.isArray(entry.fields)) {
      for (const field of entry.fields) {
        if (matches(field.label)) return true
        if (matches(field.explanation)) return true
        if (matches(field.whyItMatters)) return true
      }
    }

    return false
  })
}
