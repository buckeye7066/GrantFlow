# What I’d Do Next to Make GrantFlow More User-Friendly

After reviewing the repo (post–simplified-nav merge), here’s what I’d change next, in order of impact vs effort.

---

## 1. **Replace “crawler” language with outcome language (high impact, low effort)**

**Where:** Discover Grants, Documents, Pipeline, Item Funding, Funding Opportunities, Data Sources, Automation.

**Issue:** Words like “crawler,” “run crawlers,” “Enrich profile,” “Process All” are technical. Non-technical users think in goals: “find grants,” “update my info,” “move my applications.”

**Concrete changes:**

| Location | Current copy | Friendlier copy |
|----------|--------------|------------------|
| `DiscoverGrants.jsx` ~333 | “Choose a profile to run real web crawlers and find matching opportunities” | “Choose a profile to search for grants and programs that match you.” |
| `DiscoverGrants.jsx` toast ~141 | “Crawler complete” | “Search complete” or “We found opportunities” |
| `Documents.jsx` ~377 | “Enrich Profile” button | “Update profile from documents” or “Extract info from documents” |
| `Documents.jsx` ~384–391 | “Most recent enrichment” / “Enrichment running” | “Profile update” / “Updating profile from documents…” |
| `Pipeline.jsx` ~386 | “Master Grant Pipeline” | “Your applications” (matches nav) |
| `Pipeline.jsx` ~406–421 | “Process All” button (admin) | “Update all applications” or “Re-match all” + tooltip: “Re-run matching for applications in this view.” |
| `CrawlerSelection.jsx` | Component is still “crawler” internally; labels in Discover can say “Search by: Local funding, Government, Health…” instead of “run crawlers.” |

**Files:** `src/pages/DiscoverGrants.jsx`, `src/pages/Documents.jsx`, `src/pages/Pipeline.jsx`, `src/components/discovery/CrawlerSelection.jsx` (any user-visible labels).

---

## 2. **Documents: one primary action, rest under “Advanced” (high impact, medium effort)**

**Where:** `src/pages/Documents.jsx`.

**Issue:** Profile selector + Upload + “Enrich Profile” + “Parse all” + OCR toggle all compete. Main user goal: “Upload a document.”

**Change:**

- **Primary:** One clear block: “Upload a document” (profile dropdown if multiple, file input, one Upload button). Optional one-line: “We’ll read the file and pull key details into this profile.”
- **Secondary:** “Update profile from documents” (current “Enrich Profile”) as a separate, lower-emphasis action (e.g. under “Update profile” or “Advanced”).
- **Advanced / later:** “Parse all,” handwriting OCR, enrichment job history behind an “Advanced” or “Options” expandable section so they don’t clutter the first screen.

**File:** `src/pages/Documents.jsx` (reorder/group UI, add collapsible “Advanced” or “Options”).

---

## 3. **Organizations / Profiles: one “Add” path for first-time users (high impact, medium effort)**

**Where:** `src/pages/Organizations.jsx`, `OrganizationActions.jsx`.

**Issue:** Four actions: “Print Blank Form,” “Upload Completed Form,” “Quick Add,” “New Application.” New users don’t know which to use.

**Change:**

- **When 0 profiles:** Single primary CTA: “Add your organization” (or “Create your first profile”) that opens one flow—e.g. Quick Add or a short wizard. Hide or de-emphasize “Upload,” “Print,” “New Application” until they have at least one profile.
- **When they already have profiles:** Keep current actions but add a short line under the title: “Add another organization” or “Manage who you’re applying for.”
- Optionally rename “Quick Add” to “Add organization” and “New Application” to “Full application form” so the difference is clear.

**Files:** `src/pages/Organizations.jsx`, `src/components/organizations/OrganizationActions.jsx`, and any empty-state that points to “create first profile.”

---

## 4. **ProfileDetail: reduce tab overload (high impact, higher effort)**

**Where:** `src/pages/ProfileDetail.jsx` (TabsList with 9–11 tabs).

**Issue:** Too many tabs (Profile, Pipeline, Item Funding, Grant Deadline, Grant Monitoring, Proposals, Documents, Billing, Personalization, + conditional). Hard to know “what do I do next?”

**Change:**

- **Option A (simpler):** Group into 3–4 tabs, e.g. “About” (profile info + avatar), “Applications & deadlines” (pipeline, deadlines, monitoring, proposals), “Documents & billing” (documents, billing), “Settings” (personalization, theme). Move Item Funding / Universities / Health into sub-sections or a “More” area.
- **Option B:** Keep structure but add a small “Suggested next step” or “Quick action” at the top (e.g. “Complete basic info” or “Upload a document”) that deep-links to the right tab. Reuse the same “next step” logic you use for the dashboard “Resume where you left off.”

**File:** `src/pages/ProfileDetail.jsx`.

---

## 5. **Dashboard: soften jargon in hero and cards (medium impact, low effort)**

**Where:** `src/pages/Dashboard.jsx`.

**Issue:** “Operational pulse across all grants and obligations,” “Leverage AI nudges and smart filters” feel like marketing/tech speak.

**Change:**

- Hero title: e.g. “Your grants at a glance” or “What’s next for your applications.”
- Subtitle: e.g. “See deadlines, next steps, and recent activity. Find new grants or pick up where you left off.”
- Keep the single primary CTA “Find Grants” and the “Resume where you left off” panel as-is.

**File:** `src/pages/Dashboard.jsx` (lines ~401–408).

---

## 6. **Pipeline: hide “Advanced” filters by default (medium impact, low effort)**

**Where:** `src/pages/Pipeline.jsx`, `AdvancedFilters.jsx`.

**Issue:** “Advanced Filters” (search, amount, funder type, application method, etc.) can overwhelm. Primary need: “See my applications and move them.”

**Change:**

- Keep the filters but default to **collapsed** or “Filters” button that opens a panel. First view: profile selector + Kanban (and optional “Remove expired” if present). “Process All” stays for admins but can stay as secondary.
- Optional: Preset chips like “Needs attention,” “By deadline,” “Drafting” that set one or two filters and hide the rest.

**Files:** `src/pages/Pipeline.jsx`, `src/components/pipeline/AdvancedFilters.jsx`.

---

## 7. **Apply / VNext: add a simple progress indicator (medium impact, medium effort)**

**Where:** `src/pages/Apply.jsx`, `VNextApplication.jsx`, `VNextFinishPacket.jsx`.

**Issue:** Multi-step flow with no visible “step 2 of 4.” Users don’t know how far they are.

**Change:**

- Add a small step bar or text at the top: “Step 1 of 3: Review” (or whatever the real steps are). Can be driven from route or a tiny state/config (e.g. steps for “Apply” vs “VNext”).
- Reuse the same lifecycle idea as the header phase indicator so wording is consistent (e.g. “Prepare → Submit → Track”).

**Files:** `src/pages/Apply.jsx`, `src/pages/VNextApplication.jsx`, `src/pages/VNextFinishPacket.jsx` (+ optional shared `ApplicationStepIndicator.jsx`).

---

## 8. **Login / first-run: one clear next step (medium impact, low effort)**

**Where:** `src/pages/Login.jsx`, `AuthShell` / `AuthMethodTabs`, and the redirect after login.

**Issue:** After login, users land on Dashboard or Organizations. If they’re new, a single line of guidance (“Next: add your organization” or “Next: find your first grant”) would reduce confusion.

**Change:**

- After first login (or when `profiles.length === 0`), show a small persistent banner or card at the top: “Welcome. First, add your organization so we can find grants for you.” with a CTA to Organizations (or the profile wizard). Dismissible or until they create a profile.
- Login page: one short line under the form, e.g. “First time? You’ll set your password from an email link, then add your organization.”

**Files:** `src/pages/Login.jsx`, `src/pages/Dashboard.jsx` (or a small `FirstRunBanner.jsx` used in Layout/Dashboard when no profiles).

---

## 9. **Source Directory table: simplify columns on small screens (lower impact, medium effort)**

**Where:** `src/pages/SourceDirectory.jsx` (table with 10 columns).

**Issue:** On mobile or narrow windows, 10 columns are hard to scan.

**Change:**

- Default view: show fewer columns (e.g. Name, Type, Last crawled, Actions). Move Location, Frequency, Opportunities, Status into a row expand/details panel or a “Details” view.
- Or: keep full table for desktop, switch to card list on small breakpoint (one card per source with key fields and “View details”).

**File:** `src/pages/SourceDirectory.jsx`.

---

## 10. **Global search / “Go to” (nice to have)**

**Where:** Layout header or a command palette.

**Issue:** With 5 main nav items + “More,” power users still need to jump to “Billing” or “Parse NOFO” quickly.

**Change:**

- Add a keyboard shortcut (e.g. Ctrl+K or Cmd+K) that opens a small “Go to page” or search (using existing `command.jsx`). List main + More routes with outcome labels from `src/config/navigation.js`. No backend required.

**Files:** `src/pages/Layout.jsx`, `src/components/ui/command.jsx`, `src/config/navigation.js`.

---

## Summary

| Priority | What | Impact | Effort |
|----------|------|--------|--------|
| 1 | Replace “crawler” / “enrich” / “Process All” with outcome copy | High | Low |
| 2 | Documents: one primary action (Upload), rest under Advanced | High | Medium |
| 3 | Organizations: single “Add organization” path when 0 profiles | High | Medium |
| 4 | ProfileDetail: fewer tabs or “suggested next step” | High | Higher |
| 5 | Dashboard hero: plain-language title/subtitle | Medium | Low |
| 6 | Pipeline: filters collapsed by default | Medium | Low |
| 7 | Apply/VNext: step indicator | Medium | Medium |
| 8 | First-run / login: one clear “next step” | Medium | Low |
| 9 | Source Directory: responsive table/cards | Lower | Medium |
| 10 | Global “Go to” (e.g. Cmd+K) | Nice to have | Medium |

I’d start with **1 (copy)** and **5 (dashboard hero)** for quick wins, then **2 (Documents)** and **3 (Organizations)** for the biggest clarity gains for new users.
