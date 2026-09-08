import {
  Brain,
  Calendar,
  ClipboardList,
  Database,
  DatabaseZap,
  FileStack,
  FileText,
  FolderOpen,
  HandCoins,
  Kanban,
  LayoutDashboard,
  Layers,
  Leaf,
  LifeBuoy,
  Search,
  Sparkles,
  Star,
  Target,
  UserRound,
} from 'lucide-react'

import { createPageUrl } from '@/utils'

/**
 * The end-user (non-admin) sidebar.
 *
 * Owner order 2026-09-07: an end user "should see these options (keeping
 * nonadmin tools only)" — the Find Funding group, its advanced tools, and the
 * Work group exactly as the admin sidebar shows them. Every non-admin profile
 * is entitled to the highest non-admin tier since #1611, so the tools are
 * visible; the four that depend on a capability carry `requiresCapability`
 * (the hook's own names: documentAI / itemFunding / pipelineAutomation) and
 * the layout hides them only when the profile's entitlement says no.
 *
 * Group ids match the admin sidebar (home / find / work) so breadcrumbs and
 * group-open state resolve the same way for both shells. Admin-only items
 * (Crawl Coverage, Admin Panel) and the Admin / Operations group stay out.
 */
export const END_USER_NAV_GROUPS = Object.freeze([
  {
    groupId: 'home',
    label: 'Home',
    groupI18nKey: 'nav.group.home',
    icon: LayoutDashboard,
    items: [
      { title: 'Dashboard', i18nKey: 'nav.dashboard', routeName: 'Dashboard', url: createPageUrl('Dashboard'), icon: LayoutDashboard },
      { title: 'Calendar', i18nKey: 'nav.calendar', routeName: 'Calendar', url: createPageUrl('Calendar'), icon: Calendar },
      {
        // The person's OWN profile page (owner order 2026-09-07: "he can't see
        // his profile to finish filling it out"). `usesActiveProfile` makes the
        // layout append `?id=<active profile>` at render time.
        title: 'My Profile',
        routeName: 'ProfileDetail',
        url: createPageUrl('ProfileDetail'),
        icon: UserRound,
        usesActiveProfile: true,
      },
    ],
  },
  {
    groupId: 'find',
    label: 'Find Funding',
    groupI18nKey: 'nav.group.find',
    icon: Search,
    items: [
      { title: 'Discover Grants', i18nKey: 'nav.discoverGrants', routeName: 'DiscoverGrants', url: createPageUrl('DiscoverGrants'), icon: Search },
      { title: 'No-Cost Green Home Upgrades', i18nKey: 'nav.greenHomePrograms', routeName: 'GreenHomePrograms', url: createPageUrl('GreenHomePrograms'), icon: Leaf },
      { title: 'Saved Grants', i18nKey: 'nav.savedGrants', routeName: 'SavedGrants', url: createPageUrl('SavedGrants'), icon: Star },
      { title: 'Funding Results', i18nKey: 'nav.fundingResults', routeName: 'FundingResults', url: createPageUrl('FundingResults'), icon: Search },
      { title: 'Smart Matcher', i18nKey: 'nav.smartMatcher', routeName: 'SmartMatcher', url: createPageUrl('SmartMatcher'), icon: Brain },
      { title: 'Profile Matcher', i18nKey: 'nav.profileMatcher', routeName: 'ProfileMatcher', url: createPageUrl('ProfileMatcher'), icon: Target },
      { title: 'Funding Opportunities', i18nKey: 'nav.fundingOpportunities', routeName: 'FundingOpportunities', url: createPageUrl('FundingOpportunities'), icon: Layers },
      { title: 'Item Requests', routeName: 'ItemFunding', url: createPageUrl('ItemFunding'), icon: HandCoins, requiresCapability: 'itemFunding' },
      { title: 'Funder', i18nKey: 'nav.funder', routeName: 'Funder', url: createPageUrl('Funder'), icon: HandCoins },
      { title: 'Data Sources', i18nKey: 'nav.dataSources', routeName: 'DataSources', url: createPageUrl('DataSources'), icon: Database },
      { title: 'Source Directory', i18nKey: 'nav.sourceDirectory', routeName: 'SourceDirectory', url: createPageUrl('SourceDirectory'), icon: DatabaseZap },
      { title: 'NOFO Parser', i18nKey: 'nav.nofoParser', routeName: 'NOFOParser', url: createPageUrl('NOFOParser'), icon: FileStack, isAdvanced: true, requiresCapability: 'documentAI' },
      { title: 'AI Grant Scorer', i18nKey: 'nav.aiGrantScorer', routeName: 'AIGrantScorer', url: createPageUrl('AIGrantScorer'), icon: Brain, isAdvanced: true, requiresCapability: 'documentAI' },
    ],
  },
  {
    groupId: 'work',
    label: 'Work',
    groupI18nKey: 'nav.group.work',
    icon: Kanban,
    items: [
      { title: 'Pipeline', i18nKey: 'nav.pipeline', routeName: 'Pipeline', url: createPageUrl('Pipeline'), icon: Kanban },
      { title: 'Process with Hamilton', i18nKey: 'nav.processWithHamilton', routeName: 'HamiltonProcessing', url: createPageUrl('HamiltonProcessing'), icon: Sparkles, requiresCapability: 'pipelineAutomation' },
      { title: 'Applications', i18nKey: 'nav.applications', routeName: 'Applications', url: createPageUrl('Applications'), icon: ClipboardList },
      { title: 'Proposals', i18nKey: 'nav.proposals', routeName: 'Proposals', url: createPageUrl('Proposals'), icon: FileText },
      { title: 'Documents', i18nKey: 'nav.documents', routeName: 'Documents', url: createPageUrl('Documents'), icon: FolderOpen },
      { title: 'Printable Application', i18nKey: 'nav.printableApplication', routeName: 'PrintableApplication', url: createPageUrl('PrintableApplication'), icon: FileText },
    ],
  },
  {
    groupId: 'support',
    label: 'Support',
    icon: LifeBuoy,
    items: [
      { title: 'Ask Anya', routeName: 'Help', url: createPageUrl('Help'), icon: LifeBuoy },
    ],
  },
])

/** Route names an end user can reach from the sidebar. */
export const END_USER_ROUTE_NAMES = Object.freeze(
  END_USER_NAV_GROUPS.flatMap((group) => group.items.map((item) => item.routeName)),
)
