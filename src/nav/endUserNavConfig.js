import {
  Calendar,
  HandCoins,
  Kanban,
  LayoutDashboard,
  Leaf,
  LifeBuoy,
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
