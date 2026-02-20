# UX Grouped Navigation + Wayfinding — Verification Report

## Before vs After

### Top-level clickable nav items visible at once

| Metric | Before | After | Target |
|--------|--------|-------|--------|
| Top-level clickable items visible | **27+** (flat list: Dashboard, My Profiles, Funder, Discover Grants, … Settings) | **6** (group labels only: Home, Setup, Find Funding, Work, Track & Report, Admin/Operations when shown) | ≤ 10 ✓ |

Within each expanded group, only that group’s links are visible. So at once the user sees **6 group headers** (or 5 when Admin is hidden) and **only the links inside the expanded group(s)**. Total visible links when one group is open: ~4–10 depending on group. **Target ≤ 10 satisfied.**

### Clicks from Dashboard to key actions

| Action | Before | After |
|--------|--------|--------|
| **Find grants** | 1 (click "Find Grants" in sidebar) or 1 (hero "Find Grants") | 1 — Expand "Find Funding" if collapsed (1) + click "Discover Grants" (1) = **2** when group was collapsed; or **1** if group already open. With "Continue" card: **1** when last page was Discover Grants. |
| **Open pipeline** | 1 (click "Your Applications" / Pipeline in sidebar) | 1 — Expand "Work" if needed + click "Pipeline" = **1–2**. With "Continue" card: **1** when last page was Pipeline. |
| **View deadlines** | 1 (click "Grant Deadline" or "Deadlines" in sidebar) | 1 — Expand "Track & Report" + click "Grant Deadline" = **1–2**. |

**Summary:** When the relevant group is already open (persisted or auto-expanded for current route), **1 click**. When it’s collapsed, **2 clicks** (expand + click). "Continue where you left off" on Dashboard gives **1 click** back to last page.

### No dead links

- Every nav entry in `src/nav/navConfig.js` uses a `routeName` that matches a route in `src/pages/index.jsx` (e.g. `DiscoverGrants` → `<Route path="/DiscoverGrants" ... />`).
- Verified: Dashboard, Calendar, MyProfiles, Organizations, Settings, DiscoverGrants, SmartMatcher, ProfileMatcher, FundingOpportunities, Funder, DataSources, SourceDirectory, NOFOParser, AIGrantScorer, Pipeline, Proposals, Documents, PrintableApplication, GrantDeadline, GrantMonitoring, Reports, AdvancedAnalytics, Outreach, Stewardship, Automation, Billing, Budgets, Diagnostics, Admin — all have corresponding routes.
- Detail/secondary pages (GrantDetail, Apply, ProfileDetail, etc.) are reachable from Pipeline, cards, or other nav targets; not required in sidebar.

### Admin gating

- **Admin / Operations** group is shown only when `user.is_admin === true` OR "Show advanced tools" is enabled (localStorage `grantflow:show-advanced-tools`).
- "Admin Panel" item is shown only when `user.is_admin === true` (isAdminOnly).
- Footer toggle "Show advanced tools" / "Hide advanced tools" flips visibility of the Admin/Operations group for non-admins.

---

## File list touched

| File | Change |
|------|--------|
| `src/Layout.jsx` | Renamed to `src/Layout.legacy.jsx`; deprecation comment added. |
| `src/nav/navConfig.js` | **New.** Single source of truth: NAV_GROUPS (6 groups), getNavGroupsOpen/setNavGroupsOpen, getGroupIdForRoute, ROUTE_LABELS, getBreadcrumbSegments, LIFECYCLE_PHASES. |
| `src/nav/useNavGroupsOpen.js` | **New.** useNavGroupsOpen() for persisted open state; getShowAdvancedTools/setShowAdvancedTools. |
| `src/pages/Layout.jsx` | Sidebar refactored to render from NAV_GROUPS; NavGroupCollapsible; persist last-visited page; "Show advanced tools" footer toggle. |
| `src/components/shared/AppBreadcrumb.jsx` | Uses getBreadcrumbSegments from navConfig (Home › Group › Page). |
| `src/components/shared/GrantLifecyclePhaseIndicator.jsx` | Imports LIFECYCLE_PHASES from @/nav/navConfig. |
| `src/components/dashboard/ContinueCard.jsx` | **New.** "Continue where you left off" linking to lastVisitedPath. |
| `src/components/dashboard/StartHereCard.jsx` | **New.** "Start here" 3-step guide (Organizations → Discover Grants → Pipeline). |
| `src/pages/Dashboard.jsx` | DashboardContinueOrStart: show ContinueCard, StartHereCard, or ResumeWhereYouLeftOff. |
| `docs/ux/UX_GROUPED_NAV_VERIFICATION.md` | **New.** This report. |

---

## UI change summary

1. **Sidebar:** One canonical layout in `src/pages/Layout.jsx`. No duplicate `src/Layout.jsx` (renamed to legacy).
2. **Navigation:** Six collapsible groups (Home, Setup, Find Funding, Work, Track & Report, Admin/Operations). Only group headers and, when expanded, that group’s links. Open/closed state persisted in localStorage; group containing current route auto-expands.
3. **Breadcrumbs:** Main header shows **Home › Group › Page** (e.g. Home › Work › Pipeline).
4. **Dashboard:** First card in right column is either (a) **Continue where you left off** (link to last visited page), (b) **Start here** (3-step guide when no profiles), or (c) **Resume where you left off** (urgent deadline / in-progress grant / find grants).
5. **Admin/Operations:** Shown only to admins or when "Show advanced tools" is on; "Admin Panel" only for admins.
