# Phase 1 — Traversal Friction Audit

Findings from actual frontend code. Format: **Problem** → **Why it increases cognitive load** → **Exact file/component location**.

---

## 1. Screens with more than 7 visible interactive elements

### Dashboard (`src/pages/Dashboard.jsx`)
- **Problem**: Hero has 3 buttons (Discover Grants, View Automations, Logout). Four StatCards each with link. PipelineStatusCard and PipelineActionsCard with multiple actions. UrgentDeadlinesCard, UpcomingMilestonesCard, ReminderCenterCard, RecentGrantsCard, QuickStatsCard — each with links/buttons. PersonalizationPanel, AnyaChat. **Well over 7 interactive elements** above the fold and in first scroll.
- **Why**: User must decide where to go first; no single “do this next” focus.
- **Location**: `src/pages/Dashboard.jsx` (hero `div.flex-wrap.gap-3`, StatCards grid, card grid).

### Pipeline (`src/pages/Pipeline.jsx`)
- **Problem**: Profile Select, Filter (opens AdvancedFilters), Process All (admin), Remove N Expired, AdvancedFilters (search, min/max amount, funder types, application methods, opportunity types, tags, hide expired, show only expired), Clear All Filters (empty state), per-column Kanban actions, per-card actions. **Many competing controls.**
- **Why**: Primary task “see my applications and move one forward” competes with filters, bulk actions, and admin tools.
- **Location**: `src/pages/Pipeline.jsx` (top bar ~lines 381–435, AdvancedFilters, empty-state button, KanbanBoard).

### Discover Grants (`src/pages/DiscoverGrants.jsx`)
- **Problem**: Profile selector, crawler/source selection (CrawlerSelection), search trigger, results list with per-result actions (add to pipeline, etc.), alerts, possible multiple CTAs. **7+ interactive elements.**
- **Why**: “Find a grant” is diluted by profile choice, source choice, and many result actions.
- **Location**: `src/pages/DiscoverGrants.jsx` (profile select, CrawlerSelection, SearchResults, any primary/secondary buttons).

### Documents (`src/pages/Documents.jsx`)
- **Problem**: Profile selector, file input, Upload button, “Parse all profile documents”, “Enrich profile” (AI), handwriting OCR toggle, document list with per-document actions (view, delete, etc.), enrichment job list. **7+ controls.**
- **Why**: “Upload a document” is one goal; the rest (parse all, enrich, OCR) feel like extra decisions before the user has a clear mental model.
- **Location**: `src/pages/Documents.jsx` (Select, input type file, Button Upload, Parse all, Enrich, Switch, DocumentItem actions).

### ProfileDetail (`src/pages/ProfileDetail.jsx`)
- **Problem**: 9–11 tab triggers (Profile Information, Pipeline, Item Funding, Grant Deadline, Grant Monitoring, Proposals & Files, Documents, Billing, Personalization, Universities, Health), plus per-tab content (edit, save, AI, upload). **Many competing entry points.**
- **Why**: User doesn’t know which tab holds “what I need to do next”; tabs mirror backend structure, not user goals.
- **Location**: `src/pages/ProfileDetail.jsx` TabsList/TabsTrigger (lines ~520–535).

### Admin (`src/pages/Admin.jsx`)
- **Problem**: TabsList with 10+ tabs (Applications, Logins, Profiles, Diagnostics, Knowledge Base, Upload, Geo Crawl, Automation, Anya, etc.). **Many tabs.**
- **Why**: Admin has many jobs, but one screen with 10+ tabs forces scanning and deciding.
- **Location**: `src/pages/Admin.jsx` TabsList (lines 54–80+).

### Funding Opportunities (`src/pages/FundingOpportunities.jsx`)
- **Problem**: Large page (1700+ lines) with profile/state selection, filters, opportunity cards, dialogs, create grant/document flows. **Many interactive elements.**
- **Why**: “Find and add an opportunity” is buried in filters, lists, and multi-step dialogs.
- **Location**: `src/pages/FundingOpportunities.jsx` (full page).

### Organizations (`src/pages/Organizations.jsx`)
- **Problem**: Search, type filter, Quick Add, Upload Form, Comprehensive Form, org cards with actions. **Multiple primary actions.**
- **Why**: “Add my organization” competes with “upload form” and “comprehensive form” and search/filter.
- **Location**: `src/pages/Organizations.jsx` (filters, OrganizationActions, dialogs).

---

## 2. Screens with more than 2 competing primary buttons

### Dashboard
- **Problem**: “Discover Grants” (primary), “View Automations” (outline), “Logout” (ghost) in hero. **Three top-level actions.**
- **Location**: `src/pages/Dashboard.jsx` lines 410–431.

### Pipeline (empty state)
- **Problem**: “Clear All Filters” vs implied “Discover grants” (no explicit CTA in empty state). Top bar: Process All, Remove N Expired. **Multiple primary-style actions.**
- **Location**: `src/pages/Pipeline.jsx` (top bar, empty-state Clear All Filters).

### Organizations
- **Problem**: Quick Add, Upload Form, Comprehensive Form — **three ways to add** without clear “start here” for a new user.
- **Location**: `src/pages/Organizations.jsx` (OrganizationActions, QuickAddDialog, UploadFormDialog, ComprehensiveApplicationForm).

### Documents
- **Problem**: Upload, Parse all, Enrich profile — **three prominent actions** before any document list.
- **Location**: `src/pages/Documents.jsx` (upload mutation, parseAll mutation, enrichment mutation triggers).

---

## 3. Tables with > 8 columns

### Source Directory
- **Problem**: Table has Checkbox, expand toggle, Name, Type, Location, Last Crawled, Frequency, Opportunities, Status, Actions. **10 columns.**
- **Why**: Hard to scan on small screens; “what matters most” is unclear.
- **Location**: `src/pages/SourceDirectory.jsx` TableHeader/TableRow (lines 876–897).

### Source Registry (if present)
- **Problem**: Table structure with multiple columns (partners table, logs table). **Check column count.**
- **Location**: `src/pages/SourceRegistry.jsx` (TableHeader/TableRow ~434–493).

---

## 4. Multi-step workflows without progress indicators

### Apply / VNext flow
- **Problem**: User goes Discover → Pipeline → GrantDetail → Apply (or VNextApplication → VNextFinishPacket). **No visible “step 2 of 5” or phase bar.**
- **Location**: `src/pages/Apply.jsx`, `src/pages/VNextApplication.jsx`, `src/pages/VNextFinishPacket.jsx` — no shared progress component.

### Profile creation
- **Problem**: Organizations → create/upload → then ProfileDetail. **No “Set up org → Find grants → …” progress.**
- **Location**: OnboardingFlow + Organizations + ProfileDetail; no progress indicator.

### Funding Opportunities
- **Problem**: Large flow (select profile/state → search/filter → select opportunity → create grant/document). **No step indicator.**
- **Location**: `src/pages/FundingOpportunities.jsx` — no stepper/progress UI.

---

## 5. Screens where the next step is not visually obvious

### After login (new user)
- **Problem**: Redirect to Dashboard or Organizations. Dashboard shows many cards; “create organization” or “find first grant” is not the single obvious next step.
- **Location**: `src/pages/Dashboard.jsx`; `src/pages/index.jsx` (redirect to Organizations when needsProfileCreation).

### After adding grants to pipeline
- **Problem**: DiscoverGrants can add matches; success toast doesn’t necessarily direct to “Review in Pipeline” or “Prepare materials” with one click.
- **Location**: `src/pages/DiscoverGrants.jsx` (handleCrawlerResults, toast).

### Pipeline empty state
- **Problem**: “No grants match your filters” / “You don’t have any grants yet” with “Clear All Filters” or “Start by discovering opportunities!” — **no single dominant CTA** to “Find grants” (e.g. button to DiscoverGrants).
- **Location**: `src/pages/Pipeline.jsx` lines 515–550 (empty state copy and single Clear All Filters button; no Discover link in that block).

### ProfileDetail
- **Problem**: **Next step is unclear**; 9+ tabs with no “Complete this first” or “Recommended next” for grant applications.
- **Location**: `src/pages/ProfileDetail.jsx` (tabs only; no guidance copy or phase indicator).

---

## 6. Technical language exposed to users

- **“Crawler” / “CrawlerSelection”**: Discovery is framed as running a “crawler” (DiscoverGrants, FundingOpportunities). **Location**: `src/components/discovery/CrawlerSelection.jsx`, copy in DiscoverGrants.
- **“Pipeline”**: Common in product but technical. **Location**: Layout.jsx “Pipeline”, Pipeline.jsx “Master Grant Pipeline”.
- **“Process All”**: Implies batch job, not outcome. **Location**: `src/pages/Pipeline.jsx` button “Process All”.
- **“Enrich profile” / “Profile enrichment”**: Jargon. **Location**: `src/pages/Documents.jsx` (Enrich profile button, enrichment job copy).
- **“NOFO Parser”**: Acronym + technical. **Location**: Layout.jsx, NOFOParser.jsx.
- **“Profile Matcher” / “Smart Matcher”**: “Matcher” is system-term. **Location**: Layout.jsx.
- **“Data Sources” / “Source Directory” / “Source Registry”**: Overlapping technical terms. **Location**: Layout.jsx.
- **“Diagnostics”**: Developer-facing. **Location**: Layout.jsx developerItems.
- **“vNext Applications”**: Internal product name. **Location**: Pipeline.jsx (vNextApplications section).

---

## 7. Configuration panels exposed before needed

- **Advanced Filters on Pipeline**: Full filter panel (funder types, application methods, opportunity types, tags, amount, expired) is visible/one click away before user has any grants. **Location**: `src/pages/Pipeline.jsx` + `AdvancedFilters.jsx`.
- **Dashboard PersonalizationPanel**: Layout/theme preferences on main dashboard. **Location**: `src/pages/Dashboard.jsx` (PersonalizationPanel in right column).
- **ProfileDetail Personalization tab**: Theme/layout in same tab set as Pipeline, Documents, Billing. **Location**: `src/pages/ProfileDetail.jsx` (Personalization tab).
- **Documents**: “Handwriting OCR” and “Parse all” / “Enrich” before first upload. **Location**: `src/pages/Documents.jsx`.

---

## 8. Summary counts (for Phase 5)

- **Screens with >7 interactive elements**: Dashboard, Pipeline, DiscoverGrants, Documents, ProfileDetail, Admin, FundingOpportunities, Organizations.
- **Screens with >2 primary buttons**: Dashboard (3 in hero), Pipeline (Process All, Remove Expired; empty state Clear Filters), Organizations (Quick Add, Upload, Comprehensive), Documents (Upload, Parse all, Enrich).
- **Tables >8 columns**: SourceDirectory (10).
- **Multi-step flows without progress**: Apply/VNext, profile creation, Funding Opportunities flow.
- **Next step not obvious**: Post-login Dashboard, post–add-to-pipeline, Pipeline empty state, ProfileDetail.
- **Technical terms**: Crawler, Pipeline, Process All, Enrich profile, NOFO Parser, Profile Matcher, Smart Matcher, Data Sources, Source Directory, Source Registry, Diagnostics, vNext.
- **Config exposed early**: Advanced Filters (Pipeline), Personalization (Dashboard + ProfileDetail), Documents OCR/Enrich before first upload.
