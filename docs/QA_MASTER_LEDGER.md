# QA Master Ledger (Local Dev)

This ledger captures **issues found during manual UI/button testing** in local dev while logged in.

## How to log an issue

Add a row with:
- **Page/Flow**
- **Action**
- **Expected vs Actual**
- **Repro (minimal)**
- **Evidence**: console error, network request (path + status), or server log snippet
- **Fix**: link to file(s) changed

## Active Issues

| ID | Page/Flow | Action | Expected | Actual | Evidence | Status | Fix |
| --- | --- | --- | --- | --- | --- | --- | --- |
| QA-003 | Source Directory → Add Source | Open “Add Source” dialog | No console errors/warnings | React logs a console error about missing Dialog description (`aria-describedby`) | Console: `Warning: Missing Description or aria-describedby={undefined} for {DialogContent}.` | Fixed | `src/pages/SourceDirectory.jsx` |

## Closed Issues

| ID | Page/Flow | Summary | Fix |
| --- | --- | --- | --- |
| QA-001 | Data Sources → Grants.gov | Grants.gov crawler used legacy endpoint (405). Switched to the correct `search2` POST API and fixed response parsing so the UI shows real counts. | `backend/services/grantsDotGovCrawler.js` |
| QA-002 | Source Directory | `SourceDirectory` entity and related function endpoints were missing, causing in-memory stub usage and non-functional CRUD/crawl/delete. Added DB table migration + API route + legacy function endpoints + frontend wiring. | `backend/routes/sourceDirectory.js`, `backend/routes/legacyFunctions.js`, `backend/db/migrations/011_add_source_directory.sql`, `src/api/client.js`, `src/components/sources/AddSourceForm.jsx` |

