import { getTourStepsForRole } from '@/config/helpRegistry'

/**
 * The post-intake guided first-cycle tour's step registry. Two step shapes:
 *
 *   - Hands-on steps (targetKey set): spotlight a real, already-mounted DOM
 *     element that a page component registers via
 *     useGuidedTourStore.registerTarget(targetKey, ref).
 *   - Trailing "other features" steps (targetKey: null): rendered as a
 *     centered, un-spotlighted card by AnyaCoachmark -- reused verbatim from
 *     helpRegistry.getTourStepsForRole so page copy never forks between the
 *     old AnyaGuidedTour and this one.
 *
 * `completion`:
 *   - 'manual'       -> Next is enabled immediately; an informational step.
 *   - 'event:<name>' -> Next stays disabled until the matching
 *                       reportCompletion(stepId) call fires from the real
 *                       action's existing handler (see hook-in points below);
 *                       firing it auto-advances the tour, no click needed.
 *
 * `kind: 'automation-choice'` marks the one step GuidedCycleTour renders
 * with a custom body (the simplified automation toggles) instead of plain
 * coachmark text -- see GuidedCycleTour.jsx's AutomationChoiceBody.
 */
const HANDS_ON_STEPS = [
  {
    id: 'discover-intro',
    route: '/DiscoverGrants',
    targetKey: 'discover.searchButton',
    title: "Let's find your first real match",
    body: "This is where I crawl grants, scholarships, and other funding sources for you. Click search and I'll get to work.",
    completion: 'manual',
  },
  {
    id: 'discover-crawl',
    // The results panel only mounts once there ARE results, so this step
    // (shown WHILE waiting for them) spotlights the always-present search
    // area instead -- 'discover-add' below switches to the results panel
    // once it actually exists.
    route: '/DiscoverGrants',
    targetKey: 'discover.searchButton',
    title: 'Your matches are coming in',
    body: "I'm checking real sources against your profile right now -- results will start appearing in a moment.",
    completion: 'event:discover-crawl',
  },
  {
    id: 'discover-add',
    route: '/DiscoverGrants',
    targetKey: 'discover.resultsPanel',
    title: 'Add one to your pipeline',
    body: 'Pick a match that looks promising and click "Add to Pipeline" on it -- that\'s the one we\'ll carry through the rest of the tour.',
    completion: 'event:discover-add',
  },
  {
    id: 'pipeline-board',
    route: '/Pipeline',
    targetKey: 'pipeline.board',
    title: 'This is your pipeline',
    body: 'Every funding source you\'re pursuing lives here, organized by stage -- from newly discovered all the way to submitted.',
    completion: 'manual',
  },
  {
    id: 'pipeline-drag',
    route: '/Pipeline',
    targetKey: 'pipeline.firstCard',
    title: 'Move it forward',
    body: 'Drag this card into the next stage -- that\'s how you tell GrantFlow (and me) that you\'re actively working it.',
    completion: 'event:pipeline-drag',
  },
  {
    id: 'grant-detail',
    route: '/GrantDetail',
    targetKey: 'grantDetail.overview',
    title: 'Here is the full picture',
    body: 'Funding amount, deadline, eligibility, and everything else I found all live on this page, per funding source.',
    completion: 'manual',
  },
  {
    id: 'hamilton-open',
    route: '/GrantDetail',
    targetKey: 'grantDetail.hamiltonOpenLink',
    title: "Now let's watch Hamilton work",
    body: "Hamilton is the assistant who can open a portal and fill out an application for you. Click this and I'll watch it open the real portal alongside you -- nothing gets submitted without your say-so.",
    completion: 'event:hamilton-portal-opened',
  },
  {
    id: 'automation-preferences',
    route: '/GrantDetail',
    targetKey: null,
    kind: 'automation-choice',
    title: 'How hands-on do you want to be?',
    body: null, // rendered by GuidedCycleTour's AutomationChoiceBody
    completion: 'manual',
  },
]

const OTHER_FEATURE_KEYS = ['Dashboard', 'MyProfiles', 'SmartMatcher', 'GrantDeadline', 'Help']

function adaptHelpRegistryStep(entry) {
  return {
    id: `feature-${entry.key}`,
    route: entry.route,
    targetKey: null,
    title: entry.title,
    body: entry.description || entry.purpose,
    completion: 'manual',
  }
}

const roleSteps = getTourStepsForRole('user')
const OTHER_FEATURE_STEPS = OTHER_FEATURE_KEYS
  .map((key) => roleSteps.find((s) => s.key === key))
  .filter(Boolean)
  .map(adaptHelpRegistryStep)

export const GUIDED_TOUR_STEPS = [...HANDS_ON_STEPS, ...OTHER_FEATURE_STEPS]
