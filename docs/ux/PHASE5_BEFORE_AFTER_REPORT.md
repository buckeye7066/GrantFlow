# Phase 5 — Before vs After Report

## Old navigation structure

- **Sidebar**: Single flat list of **27 items** under "Navigation":
  - Dashboard, My Profiles, Funder, Discover Grants, Smart Matcher, Item Funding, Profile Matcher, Pipeline, Outreach, Grant Deadline, Grant Monitoring, Proposals, Stewardship, Reports & Analytics, Advanced Analytics, Billing & Invoicing, Budgets, Documents, Calendar, Automation, Funding Opportunities, Data Sources, Source Directory, Printable Application, AI Grant Scorer, NOFO Parser, Settings.
- **Developer**: 1 item (Diagnostics).
- **Admin**: 1 item (Admin Panel) when admin.
- **Header**: Title "GrantFlow", subtitle, Tutorial, dark mode, avatar. No breadcrumb, no lifecycle indicator.
- **Terminology**: System-focused (Pipeline, Crawler, NOFO Parser, Profile Matcher, Data Sources, Source Directory, etc.).

## New navigation structure

- **Sidebar**:
  - **Main** (5 items): Home, Your Organization, Find Grants, Your Applications, Prepare & Submit.
  - **More** (collapsible): 21 items with outcome-friendly labels (Reports & Analytics, Billing & Invoicing, Deadlines, Tracking, Match to Grants, Parse NOFO, etc.).
  - **Developer**: Diagnostics (unchanged).
  - **Admin**: Admin Panel (unchanged).
- **Header**: Same title/subtitle + **AppBreadcrumb** (e.g. Home → Your Applications) + **GrantLifecyclePhaseIndicator** (Set Up Organization → Find Grants → Review Fit → Prepare Materials → Submit → Track Status).
- **Terminology**: Outcome-focused (Find Grants, Your Applications, Prepare & Submit, Your Organization, Prepare Materials, Parse NOFO, Match to Grants, Tracking, etc.).

## Average decision count reduction

| Task | Before (approx.) | After |
|------|-------------------|--------|
| Find first grant | 2–3 (Dashboard → find right nav item among 27 → Discover Grants) | **1** (Dashboard → "Find Grants" hero button or "Resume where you left off" → Find Grants) |
| Continue last task | 2–3 (remember where to go, scan sidebar, click) | **1** (Dashboard → "Resume where you left off" → single CTA) |
| See what’s missing | Multiple (open Pipeline, Documents, ProfileDetail, etc.) | **1–2** (Resume panel suggests next step; phase indicator shows stage) |

- **Primary metric**: Clicks to discover first grant: **under 3** (now 1 from Dashboard). Clicks to continue work: **under 2** (now 1 via Resume). Clear CTA within 3 seconds: **yes** (Resume panel + Find Grants on Dashboard).

## Screens removed

- **None.** All routes remain; no screens were deleted. Access is reorganized (5 primary + More) rather than removed.

## Screens simplified

- **Dashboard**: One dominant CTA (Find Grants in hero; Resume panel with single next step). Secondary actions (Automations, Logout) de-emphasized (ghost/smaller).
- **Pipeline**: Empty state has explicit **Find Grants** button (one click to discover). Copy clarified ("No Applications Yet" / "Find grants that match your organization...").
- **Layout (global)**: Sidebar reduced to 5 visible primary items; rest under "More". Breadcrumb and lifecycle phase bar added so users always see where they are and the grant lifecycle.

## Buttons removed

- **Dashboard**: No buttons removed; "View Automations" and "Logout" made secondary (ghost, smaller). "Discover Grants" renamed to "Find Grants" and emphasized (primary, larger).
- **Pipeline**: No buttons removed; empty state gained one primary **Find Grants** button.
- **Sidebar**: No routes removed; 22 items moved from top-level list into "More" collapsible, reducing visible choices from 27 to 5 at first glance.

## Words simplified (terminology)

| Old (system) | New (outcome) |
|--------------|----------------|
| Discover Grants | Find Grants (in primary nav and hero) |
| Pipeline | Your Applications |
| Documents | Prepare & Submit (primary) / Prepare Materials (breadcrumb) |
| My Profiles | Your Organization |
| Grant Monitoring | Tracking (in More) |
| Grant Deadline | Deadlines |
| NOFO Parser | Parse NOFO |
| Profile Matcher | Match to Grants |
| Source Directory | Funding Sources |
| Reports & Analytics | (unchanged) |
| Advanced Analytics | Analytics |

(Other items in More keep clear outcome-style labels where applicable.)

## Branch and commits

- **Branch**: `ux/simplified-navigation-v1`
- **Suggested commit chunks**:
  1. docs(ux): Phase 0 architecture summary and Phase 1 friction audit
  2. feat(nav): central nav config, 5 primary items, outcome terminology
  3. feat(nav): breadcrumb and grant lifecycle phase indicator in header
  4. feat(dashboard): Resume Where You Left Off panel, single dominant CTA
  5. feat(pipeline): empty state CTA "Find Grants"
  6. docs(ux): Phase 5 before/after report
