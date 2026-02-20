# Phase 0 — Structural Analysis: GrantFlow

## Architecture Summary

### Frontend framework
- **Stack**: React 18, Vite 7, react-router-dom 7.x
- **State**: Zustand (`authStore`, `settingsStore`), TanStack Query for server state
- **UI**: Radix primitives, Tailwind CSS, shadcn-style components under `src/components/ui/`
- **Entry**: `src/App.jsx` → `Router` (basename from `env.appBase`) → `Pages` (from `src/pages/index.jsx`)

### Routing architecture
- **Type**: Flat (no nested route segments). All routes defined in `src/pages/index.jsx` inside `LayoutRoutes`.
- **Auth**: Unauthenticated users redirect to `/login`. Authenticated users with `needsProfileCreation` and no profiles are restricted to `/Organizations` or `/MyProfiles`.
- **Public routes**: `/login`, `/set-password`, `/ServiceApplication`, `/auth/callback`. Everything else is behind `LayoutRoutes` (authenticated layout).

### Layout components
- **Root layout**: `src/pages/Layout.jsx` — wraps all authenticated content. Renders:
  - `Sidebar` (from `@/components/ui/sidebar`) with header (GrantFlow logo), navigation groups, footer (user avatar, profile switcher, logout)
  - Main area: header bar (title, Tutorial, dark mode, avatar), scrollable content `{children}`
  - `AutoTimeTracker`, `ProBonoBanner`, `OnboardingFlow`, `AnyaFloatingButton`
- **No nested layout wrappers**; each page is a full-page component.

### Sidebar / navigation implementation
- **Location**: `src/pages/Layout.jsx`, arrays `navigationItems`, `developerItems`, `adminItems`.
- **navigationItems**: 27 items (Dashboard, My Profiles, Funder, Discover Grants, Smart Matcher, Item Funding, Profile Matcher, Pipeline, Outreach, Grant Deadline, Grant Monitoring, Proposals, Stewardship, Reports & Analytics, Advanced Analytics, Billing & Invoicing, Budgets, Documents, Calendar, Automation, Funding Opportunities, Data Sources, Source Directory, Printable Application, AI Grant Scorer, NOFO Parser, Settings).
- **developerItems**: 1 item (Diagnostics).
- **adminItems**: 1 item (Admin Panel), shown only when `user?.is_admin`.
- **URLs**: Built via `createPageUrl(pageName)` in `src/utils/index.js` — e.g. `"/Dashboard"`, `"/DiscoverGrants"`.
- **State**: Navigation state is **not** centralized; routes live in `index.jsx` (path → component), labels/order in `Layout.jsx`. No single source of truth mapping path ↔ label ↔ icon.

### Dashboard structure
- **Page**: `src/pages/Dashboard.jsx`
- **Data**: Multiple useQuery hooks (currentUser, userPreferences, profiles, profileDetail, organizations, grants, milestones, expenses, pipelineStats, reminders, dashboardStats). Heavy client-side filtering (relevantGrants, urgentDeadlines, etc.).
- **Sections**: Hero card (title, CTA “Discover Grants”, “View Automations”, Logout), PipelineStatusCard, PipelineActionsCard, 4 StatCards (Funds Secured, Organizations, Active Grants, Total Expenses, Upcoming Deadlines), UrgentDeadlinesCard, UpcomingMilestonesCard, ReminderCenterCard, RecentGrantsCard, QuickStatsCard, PersonalizationPanel, AnyaChat, EmptyStateCard (admin only). **Many visible interactive elements** (stat links, buttons, cards with actions).

### Workflow components
- **Onboarding**: `OnboardingFlow.jsx` — video then optional ProfileCreationWizard; redirect to Dashboard or Organizations.
- **Discovery**: DiscoverGrants (CrawlerSelection, SearchResults), SmartMatcher, ProfileMatcher, FundingOpportunities (large multi-step UI).
- **Application**: Apply, VNextApplication, VNextFinishPacket, PrintableApplication.
- **No single “grant lifecycle” wizard**; user jumps between separate pages (Discover → Pipeline → GrantDetail → Apply, etc.).

### Grant pipeline components
- **Pipeline page**: `src/pages/Pipeline.jsx` — profile selector, filters (AdvancedFilters: search, amount, funder types, application methods, opportunity types, tags, hide/show expired), “Process All” (admin), “Remove N Expired”, KanbanBoard (16 status columns), bulk/single delete dialogs.
- **KanbanBoard**: `src/components/pipeline/KanbanBoard.jsx` — STATUSES array (16 values), horizontal scroll, GrantCard per grant.
- **Grant detail**: `src/pages/GrantDetail.jsx`; Apply flow in Apply, VNextApplication.

### Document processing UI
- **Page**: `src/pages/Documents.jsx` — profile selector, file upload (input + Upload button), OCR/handwriting toggles, document list (DocumentItem), “Parse all”, “Enrich profile” (AI), enrichment job history. Dense controls above the fold.
- **NOFO Parser**: `src/pages/NOFOParser.jsx` — separate route for NOFO URL parsing.

### Profile system UI
- **List/org**: Organizations.jsx (org cards, filters, Quick Add, Upload Form, Comprehensive Form), MyProfiles.jsx (profile cards, links to ProfileDetail/OrganizationProfile).
- **Detail**: `src/pages/ProfileDetail.jsx` — **tabs**: Profile Information, Pipeline, Item Funding, Grant Deadline, Grant Monitoring, Proposals & Files, Documents, Billing, Personalization, Universities (conditional), Health (conditional). Each tab embeds substantial content. **9–11 tabs** on one screen.
- **OrganizationProfile**: `src/pages/OrganizationProfile.jsx` — single-org view (query `?id=`).

---

## Navigation Architecture Map

```
App (Router basename)
└── Routes
    ├── /login          → Login
    ├── /set-password   → SetPassword
    ├── /ServiceApplication → ServiceApplication
    ├── /auth/callback  → AuthCallback
    └── /*              → LayoutRoutes
                          └── Layout (sidebar + main)
                              └── Routes (all below are sibling flat routes)
                                  ├── / or /Dashboard
                                  ├── /Organizations, /MyProfiles, /Funder
                                  ├── /DiscoverGrants, /SmartMatcher, /ItemFunding
                                  ├── /ProfileMatcher, /Pipeline
                                  ├── /Outreach, /GrantDeadline, /GrantMonitoring
                                  ├── /Proposals, /Stewardship, /Reports, /AdvancedAnalytics
                                  ├── /Billing, /Budgets, /Documents, /Calendar, /Automation
                                  ├── /NewProject, /GrantDetail, /Apply
                                  ├── /VNextApplication, /VNextFinishPacket
                                  ├── /InvoiceView, /CreateInvoice
                                  ├── /NOFOParser, /AIGrantScorer, /BudgetDetail
                                  ├── /PrintPipeline, /OneTimeFix
                                  ├── /DataSources, /SourceRegistry, /BackfillContacts
                                  ├── /Settings, /Diagnostics, /ComplianceReportDetail
                                  ├── /ProfileMatcher, /SourceDirectory
                                  ├── /FundingOpportunities, /GrantMonitoring
                                  ├── /PrintableApplication, /BillingSheet
                                  ├── /ProfileDetail, /OrganizationProfile
                                  ├── /Pricing, /Services, /Admin
                                  └── (no catch-all; 404 not explicit)
```

**Primary routes (by function):**
- **Auth**: 4 (login, set-password, ServiceApplication, auth/callback).
- **App primary**: ~42 authenticated routes (some overlap in naming, e.g. GrantMonitoring listed twice in nav).

**Where navigation state is defined:**
- **Sidebar labels/order/icons**: `Layout.jsx` only (`navigationItems`, `developerItems`, `adminItems`).
- **Path → component**: `index.jsx` only (inline `<Route path="..." element={...} />`). No shared route config object used by both Layout and Routes.

**Shallow vs nested:** Fully **shallow**. No route params (e.g. `/grants/:id`); GrantDetail and ProfileDetail use query (`?id=`). All authenticated routes are siblings under one Layout.

**State centralized or scattered:**
- **Auth**: Centralized in `authStore` (Zustand).
- **Active profile**: `authStore.activeProfileId`; also duplicated in URL and local state on Pipeline, DiscoverGrants, Documents (selectedProfileId).
- **Navigation / “current section”**: Not in global state; derived from `useLocation().pathname` in Layout (`currentPageName` via `_getCurrentPage`). No breadcrumb or phase state.

---

## Workflow Map: Login → Completed Submission

1. **Login**  
   User visits `/login` → email/password or social → redirect to `/auth/callback` → then redirect to `from.pathname` or `/` (Dashboard).

2. **Profile gate**  
   If `needsProfileCreation && profiles.length === 0`: redirect to `/Organizations` (or stay on MyProfiles). User creates/selects org/profile (Organizations or MyProfiles).

3. **Discover grants**  
   User goes to **Discover Grants** (`/DiscoverGrants`) or **Funding Opportunities** (`/FundingOpportunities`) or **Smart Matcher** (`/SmartMatcher`). Selects profile, runs search/crawler, sees results. Adds to pipeline (DiscoverGrants can “add 50%+ matches” in one go).

4. **Pipeline**  
   User opens **Pipeline** (`/Pipeline`). Sees Kanban (16 columns). May filter by profile, search, amount, type, etc. Can drag to change status, open grant card → **GrantDetail** (`/GrantDetail?id=...`).

5. **Prepare materials**  
   **Documents** (`/Documents`) — upload docs, optionally “Parse all” / “Enrich profile”. **ProfileDetail** (`/ProfileDetail?id=...`) — edit sections, upload documents. **NOFO Parser** (`/NOFOParser`) if needed. No single “Prepare Submission” wizard; user infers from multiple pages.

6. **Submit**  
   From GrantDetail or Pipeline card → **Apply** (`/Apply`) or **VNextApplication** (`/VNextApplication?id=...`) → **VNextFinishPacket** for completion. Or **PrintableApplication** for print/upload elsewhere.

7. **Track status**  
   **Pipeline** (status columns), **Grant Monitoring** (`/GrantMonitoring`), **Stewardship** (`/Stewardship`), **Reports** (`/Reports`), **Calendar** (`/Calendar`), **GrantDeadline** (`/GrantDeadline`).

**Summary:** Flow is **capability-shaped**, not **outcome-shaped**. User must know that “finding grants” = Discover Grants / Funding Opportunities / Smart Matcher; “my applications” = Pipeline + GrantDetail + Apply; “prepare” = Documents + ProfileDetail + NOFO Parser; “track” = Pipeline + Grant Monitoring + Stewardship + Reports. No single progress indicator or guided path from “Set up org” → “Find” → “Review” → “Prepare” → “Submit” → “Track”.

---

## UX vs domain logic

- **Mixed in pages**: Dashboard does data fetch, filtering, and layout; Pipeline does profile sync, filters, Kanban, process-all job, delete dialogs. No clear separation of “page shell” vs “workflow state machine.”
- **Profile context**: Used in many places (DiscoverGrants, Pipeline, Documents, ProfileDetail) but sometimes from URL, sometimes from authStore, sometimes from local `selectedProfileId` — inconsistent.
- **Terminology**: UI uses “Pipeline”, “Crawler”, “Profile Matcher”, “NOFO Parser”, “Process All”, “Enrich profile” — system/technical terms rather than outcome-focused labels.
