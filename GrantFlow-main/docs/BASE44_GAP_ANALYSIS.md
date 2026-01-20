## GrantFlow UI Parity – Base44 vs. Vercel/Railway Repo

_Last updated: 2026-01-16_

The Base44 workspace (`grant-flow-736bafec.base44.app`) is our **reference implementation only**. GrantFlow will ship/run from this repo (Vercel/Railway); Base44 is used purely to compare UX/data patterns and (optionally) to export reference datasets for seeding.

---

### 1. Shell & Navigation

| Area | Base44 Reference | Repo Status | Gap / Action |
| --- | --- | --- | --- |
| Sidebar navigation | 24 entries across core, AI, automation, developer tools | ✅ Navigation list now matches Base44 after 2025-12-31 update | Styling still differs (gradient background, section dividers, pill hover states). Need theme polish + responsive behaviour parity |
| Top bar | Brand lockup, theme toggle, tutorial/help, logout | ⏳ Top bar currently minimal / mobile-only | Recreate desktop header with quick links, theme menu, tutorial launcher |
| Page layout | Glassmorphism cards, gradient backgrounds, dense data blocks | ⏳ Tailwind + shadcn/ui but simpler palette | Define design tokens (colours, spacing, typography) to align with Base44 look and feel |

---

### 2. Dashboard

| Feature | Base44 | Repo | Notes & Tasks |
| --- | --- | --- | --- |
| Grant pipeline controls | “Process next grant”, “Process all”, “Enable auto-monitoring” | Not implemented | Requires workflow endpoints + UI command bar |
| Metric cards | Organisations, Active Grants, Expenses, Deadlines w/ drill-down links | Basic stats exist, styling differs | Refresh component visuals, ensure counts align with Railway data |
| Personalisation panel | Toggle visible fields, default sort/layout, dark mode switch | Missing | Build preferences store per-user (localStorage + backend) |
| Deadline reminders | Urgent / upcoming lists with CTA buttons | Partial (UrgentDeadlinesCard) | Expand to match Base44 (buttons, reminder settings modal) |
| FAFSA tracker | Completion statuses, external links | Missing | Decide if included; requires data model + UI |
| IRS quick links / Tax Center | Inline resource cards | Missing | Simple content blocks sourcing from config |
| Recent grants list | Scrollable list with statuses | Present but simpler | Align layout, include CTA buttons |
| AI action cards (“Enhance AI Grant Matching” etc.) | CTA buttons + request composer | Missing | After AI endpoints defined, add card grid |

---

### 3. Primary Modules

| Page | Current State | Action Items |
| --- | --- | --- |
| **Organizations** | Migrated to React; needs Base44 styling + comprehensive profile data model | AI-assisted sections live (basic info, financial, health, demographics, family, military, occupation, location, narrative). Next: full layout polish + remaining tabs (Compliance, Funding, Documents). |
| **Funder** | Stub | Implement funder profiles, history timelines, interactions |
| **Discover Grants** | Partially implemented | Mirror Base44 search results layout, filters, grant detail side panel |
| **Smart Matcher** | Stub | Build weighted scoring UI + AI explanations |
| **Item Funding** | Stub | Create item catalogue + funding linkage |
| **Pipeline** | Basic Kanban | Add advanced filters, batch actions, print/export |
| **Contact Admin / Outreach / Grant Deadline** | Stubs | Implement support ticketing, campaign planner, timeline views |
| **Grant Monitoring** | Early version | Add alert configuration, visual timelines |
| **Proposals / Stewardship / Reports** | Present but simplified | Align with Base44 sections (AI assistants, analytics) |
| **Advanced Analytics** | Stub | Define dashboards, charts using chosen viz library (e.g. Recharts) |
| **Automation** | Stub | Provide workflow builder UI, integration hooks |
| **Funding Opportunities** | Stub | Opportunity catalogue with saved views |
| **Developer tools** | Printable Application & Diagnostics exist | Add remaining pages (User Management, Code Audit, etc.) if required |

---

### 4. Backend & Data Parity

1. **Profiles & Entities**
   - Base44 comprehensive profile schema (11 current profiles + new ones) needs to be reproduced in SQLite.
   - JSON fields, checklists, accreditation data, partnerships must be modelled in new tables.

2. **AI & Parsing**
   - Base44 leverages AI assistants per section. We must expose Railway endpoints that:
     - Aggregate existing profile data.
     - Pull parsed content from uploaded documents (OCR, PDF, DOCX).
     - Produce structured suggestions for UI acceptance.

3. **Workflows & Automations**
   - Pipeline automation (“Process next grant”) implies queue processing; requires server-side job runner.
   - Notifications / reminders rely on background jobs; plan Railway cron or external worker.

4. **Reporting & Analytics**
   - Need aggregate SQL views or denormalised tables for dashboards, analytics, forecasting.
   - Ensure CORS, auth, and rate limiting reflect production-ready defaults.

---

### 5. Implementation Roadmap

1. **Week 1**
   - Finalise data model migration (comprehensive profile schema).
   - Port dashboard visuals + metrics with live Railway data.
   - Establish design system (colours, typography, spacing) to match Base44 aesthetic.

2. **Week 2**
   - Build Organisation & Funder workspaces (tabs, AI assists).
   - Implement Discover Grants UI parity (filters, detail views).
   - Integrate deadline reminders & personalization panel.

3. **Week 3**
   - Implement Smart Matcher scoring + AI explanations.
   - Stand up Item Funding, Contact Admin, Outreach, Grant Deadline modules.
   - Start automation/notification infrastructure (background jobs).

4. **Week 4**
   - Advanced Analytics dashboards + Reporting enhancements.
   - Finalise AI assistant endpoints across sections.
   - QA, smoke tests, documentation updates.

---

### 6. Immediate Next Steps

- Capture Base44 “Code” view for key pages to identify component structure and data patterns.
- Generate a repo-side “Base44 surface area” inventory so we can reconcile Base44 → repo systematically.
  - Run: `node scripts/base44-usage-report.mjs`
  - Output: `artifacts/local/<today>/base44-usage-report.json`
- If/when you have a Base44 export JSON file (entities export), summarize it:
  - Run: `node scripts/base44-export-report.mjs path/to/data-export.json`
  - (Optional import) `node backend/import-data.js path/to/data-export.json`
- Reconcile: ensure every `base44.entities.*` and `base44.functions.invoke(*)` used by the UI maps to a real backend route (or is intentionally stubbed/removed with a documented decision).

---

Keep this document updated as features are implemented or scope changes.
