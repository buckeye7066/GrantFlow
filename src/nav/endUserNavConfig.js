import {
  Calendar,
  HandCoins,
  Kanban,
  LayoutDashboard,
  Leaf,
  LifeBuoy,
  UserRound,
} from 'lucide-react'

import { createPageUrl } from '@/utils'

/**
 * End users see the funding journey, not GrantFlow's internal machinery.
 * The hidden routes remain available to background agents and deep links;
 * they simply stop competing for attention in the primary navigation.
 */
export const END_USER_NAV_GROUPS = Object.freeze([
  {
    groupId: 'home',
    label: 'Home',
    icon: LayoutDashboard,
    items: [
      {
        title: 'Dashboard',
        routeName: 'Dashboard',
        url: createPageUrl('Dashboard'),
        icon: LayoutDashboard,
      },
      {
        title: 'Calendar',
        routeName: 'Calendar',
        url: createPageUrl('Calendar'),
        icon: Calendar,
      },
      {
        // The person's OWN profile page (owner order 2026-09-07: "he can't see
        // his profile to finish filling it out"). The end-user shell had no
        // way to reach it. `usesActiveProfile` makes the layout append
        // `?id=<active profile>` at render time.
        title: 'My Profile',
        routeName: 'ProfileDetail',
        url: createPageUrl('ProfileDetail'),
        icon: UserRound,
        usesActiveProfile: true,
      },
    ],
  },
  {
    groupId: 'funding',
    label: 'My Funding',
    icon: Kanban,
    items: [
      {
        title: 'Pipeline',
        routeName: 'Pipeline',
        url: createPageUrl('Pipeline'),
        icon: Kanban,
      },
      {
        title: 'Item Requests',
        routeName: 'ItemFunding',
        url: createPageUrl('ItemFunding'),
        icon: HandCoins,
      },
      {
        title: 'No-Cost Green Home Upgrades',
        i18nKey: 'nav.greenHomePrograms',
        routeName: 'GreenHomePrograms',
        url: createPageUrl('GreenHomePrograms'),
        icon: Leaf,
      },
    ],
  },
  {
    groupId: 'support',
    label: 'Support',
    icon: LifeBuoy,
    items: [
      {
        title: 'Ask Anya',
        routeName: 'Help',
        url: createPageUrl('Help'),
        icon: LifeBuoy,
      },
    ],
  },
])
