# Funding APIs onboarding + key management (GrantFlow)

This document explains **exactly how to manually obtain API keys** for official funding data providers and where to store them for GrantFlow (**local `.env` / Vercel / Railway secrets**).

**Important constraints**

- GrantFlow **does not** attempt to scrape, harvest, or obtain keys automatically.
- Do **not** commit secrets. `.env` / `.env.*` are already ignored by git (see `.gitignore`).

---

## Provider matrix (at-a-glance)

| Provider | What it offers | API key required? | Env var name (paste key here) | Official docs |
| --- | --- | --- | --- | --- |
| **Grants.gov REST APIs** | Federal grant opportunities (grantsws REST) | **Sometimes** (some endpoints require Help Desk ticket + encrypted key) | `GRANTS_GOV_API_KEY` | `https://www.grants.gov/api/api-guide` and `https://www.grants.gov/api` |
| **Simpler.Grants.gov API** | Applicant-friendly opportunities search API | **Yes** (key created in Developer UI after Login.gov) | `SIMPLER_GRANTS_API_KEY` | `https://wiki.simpler.grants.gov/product/api` and `https://simpler.grants.gov/developer` |
| **SAM.gov Entity Management API** | Entity lookups (UEI registrations, etc.) | **Yes** (Public API Key from SAM.gov profile) | `SAM_GOV_PUBLIC_API_KEY` | `https://open.gsa.gov/api/entity-api/` |
| **SAM.gov Get Opportunities Public API** | Contract/procurement opportunity notices | **Yes** (Public API Key from SAM.gov account details) | `SAM_GOV_PUBLIC_API_KEY` | `https://open.gsa.gov/api/get-opportunities-public-api/` |
| **api.data.gov** | Shared API key for participating agencies using api.data.gov | **Yes** (for most endpoints) | `API_DATA_GOV_KEY` | `https://api.data.gov/docs/developer-manual/` |
| **NIH RePORTER API** | NIH funded projects/awards (not open solicitations) | **No key** (public API) | *(none)* | `https://api.reporter.nih.gov/` |

---

## Where to paste keys (local + hosted)

- **Local development**
  - Backend env file: `backend/.env` (created from `backend/env.example`)
  - Frontend env file: `.env` (created from `env.example`) — typically *not* needed for these API keys
- **Railway (backend)**
  - Project → Service → Variables: add the same env vars below
- **Vercel (frontend)**
  - These are **backend** secrets. Only set on Vercel if you intentionally proxy calls through Vercel/serverless (not recommended for high-volume funding ingestion).

**Canonical env var names (use these exactly):**

- `GRANTS_GOV_API_KEY`
- `SIMPLER_GRANTS_API_KEY`
- `SAM_GOV_PUBLIC_API_KEY`
- `API_DATA_GOV_KEY`

---

## Provider details

### A) Grants.gov REST APIs (grantsws)

**What it offers**

- Federal opportunities search via grantsws REST endpoints.

**Is an API key required?**

- **Public search works without a key**, but **some endpoints require an API key** that you obtain via **Grants.gov Help Desk ticket** (per the Grants.gov API guide and API portal).

**How to obtain (manual)**

1. Review the API portal and API guide:
   - `https://www.grants.gov/api`
   - `https://www.grants.gov/api/api-guide`
2. If you need an endpoint that requires a key, follow the **Help Desk / registration instructions** in the Grants.gov documentation and request an API key.
3. Once issued, store it securely in your secrets manager.

**Where to paste the key**

- `GRANTS_GOV_API_KEY`

**Test command**

- Public search (no key) — the grantsws search endpoint is a **POST**:

```bash
curl -X POST "https://apply07.grants.gov/grantsws/rest/opportunities/search" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  -d '{"keyword":"health","oppStatuses":"posted","rows":1,"startRecordNum":0}'
```

- If you were issued a grantsws key for a protected endpoint, Grants.gov docs commonly show an `Authorization` header of the form `APIKEY=<key>` (do not paste your real key into shell history in shared environments):

```bash
curl -X POST "https://apply07.grants.gov/grantsws/rest/opportunities/search" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  -H "Authorization: APIKEY=REDACTED" \
  -d '{"keyword":"health","oppStatuses":"posted","rows":1,"startRecordNum":0}'
```

**Data model mapping notes**

- Normalized into GrantFlow `FundingOpportunity`:
  - `source`: `grants.gov`
  - `source_id`: Grants.gov opportunity id
  - `type`: `OPPORTUNITY`
  - `deadline`: `closeDate` / `closingDate` (when present)

---

### B) Simpler.Grants.gov API

**What it offers**

- A modern applicant-side search API for opportunities, with an API key managed via their developer portal.

**Is an API key required?**

- **Yes.** Requests require `X-API-Key`.

**How to obtain (manual)**

1. Go to the developer portal: `https://simpler.grants.gov/developer`
2. Sign in using **Login.gov**.
3. Create a new API key in the Developer UI (name it so you can rotate it later).
4. Copy the API key value.

**Where to paste the key**

- `SIMPLER_GRANTS_API_KEY`

**Test command**

```bash
curl -X POST "https://api.simpler.grants.gov/v1/opportunities/search" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: REDACTED" \
  -d '{"pagination":{"page_offset":1,"page_size":1,"sort_order":[{"order_by":"post_date","sort_direction":"descending"}]},"query":"health"}'
```

**Data model mapping notes**

- Normalized into GrantFlow `FundingOpportunity`:
  - `source`: `simpler.grants.gov`
  - `source_id`: `opportunity_id` (or equivalent)
  - `type`: `OPPORTUNITY`
  - `deadline`: `close_date` when present

---

### C) SAM.gov Entity Management API

**What it offers**

- Lookup details about entities (UEI-based), registrations, and related metadata.

**Is an API key required?**

- **Yes** for API usage. The Entity API documentation describes retrieving a **Public API Key** in SAM.gov account/profile details and using it (often as `api_key` query param for public endpoints).

**How to obtain (manual)**

1. Visit the Entity API docs: `https://open.gsa.gov/api/entity-api/`
2. Log into `sam.gov`.
3. Navigate to your **Profile / Account Details** and find **Public API Key**.
4. Copy the Public API Key.

**Where to paste the key**

- `SAM_GOV_PUBLIC_API_KEY`

**Test command (example)**

Entity endpoints vary by version and query shape; use the official docs for the exact endpoint you need. For connectivity testing, use the shared `test-keys` script:

```bash
node backend/scripts/test-keys.js
```

**Data model mapping notes**

- GrantFlow currently focuses on opportunity ingestion; entity lookups are typically used for enrichment/validation rather than `FundingOpportunity` rows.

---

### D) SAM.gov Get Opportunities Public API

**What it offers**

- Contract/procurement opportunity notices (search endpoint requires postedFrom/postedTo).

**Is an API key required?**

- **Yes.** The API key is supplied as the `api_key` query parameter.

**How to obtain (manual)**

1. Read the docs: `https://open.gsa.gov/api/get-opportunities-public-api/`
2. Log into `sam.gov`.
3. Go to **Account Details** and copy your **Public API Key**.

**Where to paste the key**

- `SAM_GOV_PUBLIC_API_KEY`

**Test command**

```bash
curl "https://api.sam.gov/opportunities/v2/search?api_key=REDACTED&postedFrom=01/01/2026&postedTo=01/15/2026&ptype=o&limit=1&offset=0" \
  -H "Accept: application/json"
```

**Data model mapping notes**

- Normalized into GrantFlow `FundingOpportunity`:
  - `source`: `sam.gov`
  - `opportunity_type`: `contract`
  - `type`: `OPPORTUNITY`
  - `deadline`: `responseDeadLine` when present

---

### E) api.data.gov

**What it offers**

- A single API key that many U.S. government APIs accept (agency-specific endpoints still vary).

**Is an API key required?**

- Usually **yes** (per the developer manual).

**How to obtain (manual)**

1. Read the developer manual: `https://api.data.gov/docs/developer-manual/`
2. Follow the signup instructions to obtain an API key.
3. Copy the key (store it as a secret).

**Where to paste the key**

- `API_DATA_GOV_KEY`

**Test command**

GrantFlow’s `test-keys` script validates this key (when present) using a known api.data.gov-backed endpoint:

```bash
node backend/scripts/test-keys.js
```

**Data model mapping notes**

- api.data.gov is a key *provider* rather than a single dataset; mapping depends on which downstream agency API is used.

---

### F) NIH RePORTER API

**What it offers**

- NIH funded project/award search and metadata.

**Is an API key required?**

- **No key** is required (public API). See `https://api.reporter.nih.gov/`.

**How to obtain (manual)**

- No key required.

**Where to paste the key**

- *(none)*

**Test command**

```bash
node backend/scripts/test-keys.js
```

**Data model mapping notes**

- Normalized into GrantFlow `FundingOpportunity`:
  - `source`: `nih.reporter`
  - `opportunity_type`: `award`
  - `type`: `PROGRAM` (historical funded project, not an open solicitation)

---

## Local verification script

Run all connectivity checks:

```bash
node backend/scripts/test-keys.js
```

- Exits **1** if:
  - required keys are missing (`SIMPLER_GRANTS_API_KEY`, `SAM_GOV_PUBLIC_API_KEY`), or
  - any provider check fails
- Exits **0** if all checks pass

