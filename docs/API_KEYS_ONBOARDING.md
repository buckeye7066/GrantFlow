# Funding API keys — admin setup guide (GrantFlow)

This is the **authoritative, step-by-step guide** for obtaining and installing every
API key that powers GrantFlow's funding ingest. It is written for the project owner /
admin.

> **In-app version:** the same status + setup links are available live in the admin
> panel via `GET /admin/funding-sources` (admin-only). Each source returns whether it
> is configured, where to get the key, and any caveats. This doc is the long form.

**Ground rules**

- GrantFlow **never** scrapes, harvests, or auto-generates keys. Government keys are
  identity-bound and must be created by you.
- **Never commit secrets.** `.env` and `.env.*` are git-ignored.
- Every connector is **independently key-gated**: a missing key disables only that one
  source. The others keep ingesting. Nothing is all-or-nothing.

---

## 1. At-a-glance: what needs a key

| Source | Powers ingest? | Key required? | Env var | Where to get it |
| --- | --- | --- | --- | --- |
| **Grants.gov `search2`** | ✅ yes (eligibility-filtered federal) | **No** (optional key for rate priority) | `GRANTS_GOV_API_KEY` | [grants.gov/api](https://www.grants.gov/api) · [Help Desk](https://www.grants.gov/support) |
| **Federal Register** | ✅ yes (cross-agency NOFOs, filtered) | **No** | *(none)* | [federalregister.gov/developers](https://www.federalregister.gov/developers/documentation/api/v1) |
| **NIH RePORTER** | ✅ yes (research awards) | **No** | *(none)* | [api.reporter.nih.gov](https://api.reporter.nih.gov/) |
| **NSF Awards** | ✅ yes (science/edu research) | **No** | *(none)* | [NSF Award API](https://resources.research.gov/common/webapi/awardapisearch-v1.htm) |
| **ProPublica Nonprofit Explorer** | ✅ yes (foundations / grantmakers) | **No** | *(none)* | [projects.propublica.org/nonprofits/api](https://projects.propublica.org/nonprofits/api/) |
| **Simpler.Grants.gov** | ✅ yes (modern HHS opportunities) | **Yes** (Login.gov) | `SIMPLER_GRANTS_API_KEY` | [simpler.grants.gov/developers](https://simpler.grants.gov/developers) |
| **SAM.gov Assistance Listings / Opportunities** | ✅ yes (CFDA catalog) | **Yes** (SAM.gov account) | `SAM_GOV_PUBLIC_API_KEY` | [sam.gov/profile/details](https://sam.gov/profile/details) |
| **api.data.gov** | enrichment only | Yes (self-service) | `API_DATA_GOV_KEY` | [api.data.gov/signup](https://api.data.gov/signup/) |

> ⚠️ **api.data.gov keys do NOT work for SAM.gov.** They are separate GSA systems.
> `api.sam.gov` only accepts a SAM.gov account-issued **Public API Key** — see §5.

**Five sources need no key at all** (Grants.gov, Federal Register, NIH RePORTER, NSF
Awards, ProPublica), so GrantFlow ingests from them the moment a crawl runs. Add Simpler
and SAM to widen coverage further.

**Canonical env var names — use exactly:**

```
GRANTS_GOV_API_KEY        # optional
SIMPLER_GRANTS_API_KEY    # required for Simpler.Grants.gov
SAM_GOV_PUBLIC_API_KEY    # required for SAM.gov  (alias accepted: SAM_GOV_API_KEY)
API_DATA_GOV_KEY          # enrichment only
```

---

## 2. Where to install keys

### Local development
GrantFlow loads the root `.env`. Copy the generated root `.env.example` to `.env`,
then add the variables above. `backend/env.example` is a deprecated compatibility
notice, not a configuration template.

### Railway (production backend — this is the one that matters for live crawls)
The recurring crawl runs on Railway, so a key only affects production once it's set here.

```bash
railway login                 # interactive (browser) — one time
railway link                  # select the GrantFlow project/service if not linked
railway variables --set "SIMPLER_GRANTS_API_KEY=<your-key>"
railway variables --set "SAM_GOV_PUBLIC_API_KEY=<your-key>"
railway variables             # verify (values masked)
```

Railway redeploys the service automatically when variables change. You can also set
them in the dashboard: **Project → Service → Variables**.

### Vercel (frontend)
These are **backend** secrets. Do **not** put them on Vercel unless you intentionally
proxy funding calls through Vercel serverless (not recommended for ingest volume).

---

## 3. Grants.gov  *(no key needed)*

GrantFlow's `search2` integration works without a key. Setting `GRANTS_GOV_API_KEY` only
adds an `X-API-Key` header for rate-limit prioritization if the Help Desk issues you one.

- **Get a key (optional):** [grants.gov/api](https://www.grants.gov/api) → API guide →
  Help Desk ticket at [grants.gov/support](https://www.grants.gov/support).
- **Install:** `GRANTS_GOV_API_KEY` (optional).
- **Test:**
  ```bash
  curl -X POST "https://api.grants.gov/v1/api/search2" \
    -H "Content-Type: application/json" \
    -d '{"keyword":"health","oppStatuses":"posted","rows":1,"startRecordNum":0}'
  ```

---

## 4. Simpler.Grants.gov  *(key required — ~5 min, self-service)*

1. Open **[simpler.grants.gov/developers](https://simpler.grants.gov/developers)**.
2. **Sign in** → **Sign in with Login.gov** (create or reuse a Login.gov account).
3. Open **Manage API Keys** → **Create API key** (name it, e.g. `grantflow-prod`).
4. Copy the value into `SIMPLER_GRANTS_API_KEY` (local `.env` **and** Railway).
5. **Test:**
   ```bash
   curl -X POST "https://api.simpler.grants.gov/v1/opportunities/search" \
     -H "Content-Type: application/json" -H "X-API-Key: <your-key>" \
     -d '{"pagination":{"page_offset":1,"page_size":1,"sort_order":[{"order_by":"post_date","sort_direction":"descending"}]}}'
   ```
   A `200` with a `data` array means the key is live.

Docs: [wiki.simpler.grants.gov/product/api](https://wiki.simpler.grants.gov/product/api)

---

## 5. SAM.gov  *(key required — identity-verified, read caveats first)*

> **Read this before spending time on it.** A SAM.gov **personal** key with no entity
> role is throttled to **10 requests/day** and **expires every 90 days** — not enough to
> crawl the applicant-type matrix. It is only worth wiring if you hold a SAM.gov
> **entity** account (1,000/day). Otherwise leave it unset; the other four sources
> cover federal + foundation funding without it.

1. Create / sign in to a SAM.gov account at **[sam.gov](https://sam.gov/)** (uses
   **Login.gov** identity verification).
2. Go to **[sam.gov/profile/details](https://sam.gov/profile/details)**.
3. Find the **Public API Key** field → click the **eye** icon.
4. Enter the **one-time password** sent to your registered email.
5. Copy the revealed key into `SAM_GOV_PUBLIC_API_KEY` (local `.env` **and** Railway).
6. **Test:**
   ```bash
   curl "https://api.sam.gov/assistance-listings/v1/search?api_key=<your-key>&keyword=health&limit=1"
   ```

Docs: [Assistance Listings API](https://open.gsa.gov/api/assistance-listings-api/) ·
[Get Opportunities API](https://open.gsa.gov/api/get-opportunities-public-api/) ·
[SAM API keys](https://sam.gov/content/api-keys)

---

## 6. api.data.gov  *(enrichment only — self-service)*

Used for GSA-backed enrichment endpoints, **not** for SAM.gov.

1. Sign up at **[api.data.gov/signup](https://api.data.gov/signup/)** (name + email; no
   identity proofing). Key is emailed instantly.
2. Install as `API_DATA_GOV_KEY`.

Docs: [api.data.gov/docs/developer-manual](https://api.data.gov/docs/developer-manual/)

---

## 7. NIH RePORTER & ProPublica  *(no key)*

Nothing to do — both are public. NIH RePORTER surfaces funded research awards
(`source: nih.reporter`); ProPublica surfaces real 501(c)(3) grantmakers
(`source: propublica.990`). They ingest automatically for the relevant profile types.

- NIH RePORTER: [api.reporter.nih.gov](https://api.reporter.nih.gov/)
- ProPublica Nonprofit Explorer: [projects.propublica.org/nonprofits/api](https://projects.propublica.org/nonprofits/api/)

---

## 8. Verify it worked

**Connectivity check (keys present + reachable):**
```bash
node backend/scripts/test-keys.js
```

**Coverage check (are live rows actually landing?):**
```bash
node backend/scripts/source-coverage-report.mjs            # local
railway run node backend/scripts/source-coverage-report.mjs # production
```
Before keys, every active opportunity shows `record_origin = curated_verified`. After a
crawl with keys set, you should see **`funding_api`** rows and the per-source breakdown
fill in (`grants.gov`, `simpler.grants.gov`, `nih.reporter`, `propublica.990`,
`sam.assistance`).

**In-app:** the admin panel reads `GET /admin/funding-sources` for the configured /
missing status of each provider plus these setup links.

---

## 9. Disabling a source

- Per-source: don't set its key (it self-skips and is reported in the coverage object).
- All connector ingest: set `INGEST_CONNECTORS=off`.
- Hard-enforce required keys at boot: `FUNDING_APIS_REQUIRE_KEYS=true` (errors if
  `SIMPLER_GRANTS_API_KEY` / `SAM_GOV_PUBLIC_API_KEY` are missing — leave off if you're
  intentionally running SAM-less).
