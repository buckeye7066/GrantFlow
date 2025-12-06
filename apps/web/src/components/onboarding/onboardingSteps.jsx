/**
 * Onboarding Step Definitions
 * Central registry of all onboarding steps and tours
 */

export const ONBOARDING_STEPS = {
  welcome: {
    id: 'welcome',
    title: 'Welcome to GrantFlow',
    description: 'Your AI-powered grant discovery and management platform',
    estimatedTime: '2 min',
    type: 'intro',
    order: 1
  },
  add_first_profile: {
    id: 'add_first_profile',
    title: 'Create Your First Profile',
    description: 'Add an organization or individual to start finding grants',
    estimatedTime: '3 min',
    type: 'action',
    order: 2,
    targetPage: 'Organizations'
  },
  profile_created: {
    id: 'profile_created',
    title: 'Profile Created!',
    description: 'Great job! Your profile is ready for grant matching',
    estimatedTime: '1 min',
    type: 'celebration',
    order: 3
  },
  upload_documents: {
    id: 'upload_documents',
    title: 'Upload Documents',
    description: 'Add supporting documents for stronger applications',
    estimatedTime: '2 min',
    type: 'action',
    order: 4
  },
  discover_grants_tour: {
    id: 'discover_grants_tour',
    title: 'Discover Grants',
    description: 'Learn how to find perfect-match funding opportunities',
    estimatedTime: '3 min',
    type: 'tour',
    order: 5,
    targetPage: 'DiscoverGrants'
  },
  pipeline_tour: {
    id: 'pipeline_tour',
    title: 'Manage Your Pipeline',
    description: 'Track grants from discovery to submission',
    estimatedTime: '2 min',
    type: 'tour',
    order: 6,
    targetPage: 'Pipeline'
  },
  matching_tour: {
    id: 'matching_tour',
    title: 'AI Matching',
    description: 'Understand how AI finds your best opportunities',
    estimatedTime: '2 min',
    type: 'tour',
    order: 7,
    targetPage: 'SmartMatcher'
  },
  ai_features_tour: {
    id: 'ai_features_tour',
    title: 'AI-Powered Features',
    description: 'Explore AI scoring, parsing, and automation',
    estimatedTime: '3 min',
    type: 'tour',
    order: 8
  },
  reports_tour: {
    id: 'reports_tour',
    title: 'Reports & Analytics',
    description: 'Track your grant success and generate insights',
    estimatedTime: '2 min',
    type: 'tour',
    order: 9,
    targetPage: 'Reports'
  },
  complete: {
    id: 'complete',
    title: 'All Set!',
    description: "You're ready to start winning grants",
    estimatedTime: '1 min',
    type: 'celebration',
    order: 10
  }
};

export const STEP_ORDER = Object.values(ONBOARDING_STEPS)
  .sort((a, b) => a.order - b.order)
  .map(s => s.id);

export const PAGE_TOURS = {
  Dashboard: {
    id: 'dashboard_tour',
    steps: [
      {
        target: '[data-tour="pipeline-stats"]',
        title: 'Pipeline Overview',
        description: 'See all your grants organized by status - from discovered opportunities to submitted applications.',
        position: 'bottom'
      },
      {
        target: '[data-tour="quick-actions"]',
        title: 'Quick Actions',
        description: 'Access frequently used features like discovering new grants or viewing deadlines.',
        position: 'bottom'
      },
      {
        target: '[data-tour="urgent-deadlines"]',
        title: 'Urgent Deadlines',
        description: 'Never miss a deadline - upcoming due dates are highlighted here.',
        position: 'left'
      }
    ]
  },
  Organizations: {
    id: 'organizations_tour',
    steps: [
      {
        target: '[data-tour="add-profile"]',
        title: 'Add New Profile',
        description: 'Create profiles for organizations or individuals to match with funding opportunities.',
        position: 'bottom'
      },
      {
        target: '[data-tour="profile-filters"]',
        title: 'Filter Profiles',
        description: 'Quickly find profiles by type, status, or search term.',
        position: 'bottom'
      },
      {
        target: '[data-tour="profile-card"]',
        title: 'Profile Cards',
        description: 'Each card shows key info and completeness score. Click to view details.',
        position: 'right'
      }
    ]
  },
  DiscoverGrants: {
    id: 'discover_grants_tour',
    steps: [
      {
        target: '[data-tour="profile-selector"]',
        title: 'Select a Profile',
        description: 'Choose which organization or individual to find grants for.',
        position: 'bottom'
      },
      {
        target: '[data-tour="search-templates"]',
        title: 'Search Methods',
        description: 'Pick from AI Smart Match, Quick Search, or Comprehensive Match for different search strategies.',
        position: 'bottom'
      },
      {
        target: '[data-tour="discover-button"]',
        title: 'Start Discovering',
        description: 'Click to find matching opportunities. AI will score each result based on your profile.',
        position: 'top'
      },
      {
        target: '[data-tour="search-results"]',
        title: 'Review Results',
        description: 'Results are ranked by match score. Add promising grants to your pipeline.',
        position: 'top'
      }
    ]
  },
  Pipeline: {
    id: 'pipeline_tour',
    steps: [
      {
        target: '[data-tour="pipeline-columns"]',
        title: 'Grant Stages',
        description: 'Grants move through stages: Discovered → Interested → Drafting → Submitted → Awarded.',
        position: 'bottom'
      },
      {
        target: '[data-tour="grant-card"]',
        title: 'Grant Cards',
        description: 'Each card shows key info. Click to see full details, AI analysis, and take action.',
        position: 'right'
      },
      {
        target: '[data-tour="auto-advance"]',
        title: 'Auto-Advance',
        description: 'Enable automation to move grants through stages based on activity.',
        position: 'bottom'
      }
    ]
  },
  SmartMatcher: {
    id: 'matching_tour',
    steps: [
      {
        target: '[data-tour="matcher-profile"]',
        title: 'Profile Analysis',
        description: 'AI analyzes your complete profile to find the best matches.',
        position: 'bottom'
      },
      {
        target: '[data-tour="match-results"]',
        title: 'Match Scores',
        description: 'Each opportunity gets a match percentage based on eligibility, focus areas, and more.',
        position: 'top'
      }
    ]
  }
};

export function getStepById(stepId) {
  return ONBOARDING_STEPS[stepId] || null;
}

export function getNextStep(completedSteps = []) {
  for (const stepId of STEP_ORDER) {
    if (!completedSteps.includes(stepId)) {
      return ONBOARDING_STEPS[stepId];
    }
  }
  return null;
}

export function calculateProgress(completedSteps = []) {
  const totalSteps = STEP_ORDER.length;
  const completed = completedSteps.filter(s => STEP_ORDER.includes(s)).length;
  return Math.round((completed / totalSteps) * 100);
}