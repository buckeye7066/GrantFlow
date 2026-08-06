# GrantFlow Laptop Connector

Bring files from **this laptop** into GrantFlow as **reviewable candidates** — never as silent writes.

The GrantFlow backend runs in the cloud (Railway) and cannot read your local disk. This CLI runs locally, scans the folders you allow, extracts text **on-device**, and POSTs only the text + provenance to the backend. The backend's AI (Anya) turns that text into three kinds of candidate and stages them for you to check off:

| Candidate | Routes to (on accept) | What it is |
|-----------|----------------------|------------|
| `lead` | **Yana** (`yana_lead_candidates`) | An org/person that could become a GrantFlow client |
| `funding` | **Robert** (`robert_source_candidates`) | A grant program / funder that could be a funding source |
| `profile_field` | The guarded profile-section endpoint | A value that fills a missing field on an existing profile |

**Nothing is added until you approve it** in the Laptop Inbox.

## Privacy boundary (read this)

You asked to scan *all of C: and G:*. Those drives hold regulated and privileged data — **TherapAI PHI (HIPAA)**, the **Affirm/CRISPR legal-dispute evidence**, **call recordings**, the **Incognito vault**, and **family financial** data. GrantFlow forwards ingested text to third-party AI processors, so anything ingested is published outward.

`denylist.js` therefore **excludes those folders by default** (`PROTECTED_DENYLIST`). The list is editable, but it ships protective. Removing an entry to ingest regulated data is a legal decision — talk to your attorney before doing so. The default document extensions (`.pdf/.docx/.txt/.md/.rtf/.csv`) also naturally skip source code and binaries.

## Setup

1. `cp tools/laptop-connector/config.example.json tools/laptop-connector/config.json` and edit:
   - `apiBaseUrl` → your backend URL (or set `LAPTOP_CONNECTOR_API`)
   - `roots` → folders to scan (defaults to `C:\Users\example_user` and `G:\`)
2. Export the admin token so the connector can authenticate:
   ```bash
   export LAPTOP_CONNECTOR_TOKEN="<the backend ADMIN_TOKEN>"
   ```

## Run

Always dry-run first to see exactly what would be ingested:

```bash
# from the repo root (so mammoth/pdf-parse resolve)
node tools/laptop-connector/scan.js --dry-run
```

Then the real scan:

```bash
node tools/laptop-connector/scan.js
```

Review what it found in GrantFlow → **Laptop Inbox**, or via the API:

```bash
GET  /api/laptop-connector/review
POST /api/laptop-connector/review/:id/accept
POST /api/laptop-connector/review/:id/dismiss
```

## How it stays safe

- **Raw bytes never leave the laptop** — only extracted text + a path/hash for provenance.
- **Dedupe by content hash** — re-scanning the same file won't re-create candidates.
- **Defense-in-depth redaction** — the backend scrubs SSNs / card numbers from any stored snippet.
- **Human-in-the-loop** — every candidate waits in `pending` until you accept or dismiss it.
- **Backend env** the connector relies on: `ANTHROPIC_API_KEY` (analysis), `ADMIN_TOKEN` (auth). Optional tuning: `LAPTOP_CONNECTOR_MODEL`, `LAPTOP_CONNECTOR_MAX_TEXT`, `LAPTOP_CONNECTOR_TIMEOUT_MS`.
