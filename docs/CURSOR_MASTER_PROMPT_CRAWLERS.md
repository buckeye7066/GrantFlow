# GrantFlow Crawlers — Master Prompt for Cursor

Use this as a **Cursor rule** or **master prompt** when working on GrantFlow crawlers.

**How to use:** Paste the contents (or the "Short rules summary" in §6) into a Cursor rule (e.g. `.cursor/rules/crawlers.mdc` or project rules), or paste the full doc into the chat when asking Cursor to optimize or fix crawlers. For Vercel/Railway: frontend is on Vercel (API rewrites to Railway); crawler logic runs on the backend — ensure all rules apply to backend crawlers and APIs. It encodes the product goals and constraints so that all crawler-related changes meet or exceed them.

---

## 1. Core principles

- **Real only:** Every funding source returned or stored **must have a valid, clickable URL** (http/https). No placeholders, no example.org, no "TBD" links. Filter or drop any opportunity that lacks a URL before it reaches the UI or DB.
- **No loans, no matching funds:** Under no circumstances surface or store loans, microloans, financing, or matching-fund/cost-share opportunities as if they were grants. Exclude them in crawlers, APIs, and listing layers (keyword + schema: `opportunity_type`, `is_loan`, `requires_match`).
- **Profile-driven (except Geo):** All crawlers except the Geo Crawler must use **all available profile data** (sections, signals, facets, location, demographics, academics, assistance, interests, etc.) to find funding that **matches the needs of the profile** and scores at or above the **user-chosen minimum match percentage** (Discover Grants slider: 0–100%, step 5 → `min_match_score`).
- **Slider is law:** The minimum match score from the Discover Grants slider must be respected. Only return opportunities that meet or exceed that percentage. Directory-style entry points (e.g. Benefits.gov, United Way locator) may be treated as always above threshold so users always see them, but all other results must pass the slider threshold.
- **Geo Crawler is not profile-based:** The Geo Crawler does not use a profile. It discovers **every real (URL-required) funding source** that has an address or association with a ZIP code, for **every ZIP code nationwide**. Counts per ZIP can be 3 (rural) to very large (e.g. Manhattan). Store results by **state**, sub-categorized by **ZIP**, in the Funding Opportunities tab.

---

## 2. Per-crawler goals

### 2.1 Local Crawler

- **Scope:** Search within **25 miles** of:
  - The **profile’s primary ZIP** (user location), and
  - The **ZIP of any school listed as “interested”** for students (from `university_applications.applications` and `education.interested_schools`). Include up to a reasonable limit of school ZIPs (e.g. 3–4) as additional anchors.
- **Profile usage:** Use full profile: location (ZIP, city, state), interests, demographics, keywords, applicant type. No placeholder results; only real programs with URLs.
- **Radius:** Enforce 25-mile radius from each anchor (profile ZIP + interested-school ZIPs). Do not use a different default radius without a product decision.

### 2.2 Student / School Crawler

- **Sources:** Use **school financial-aid portals** (from profile’s listed schools), **FAFSA-related/need-based** signals, and any configured school-specific endpoints to find **endowments, grants, and scholarships**.
- **Profile usage:** Use **all** student-relevant profile data:
  - **Academics:** GPA, SAT, ACT, intended major, grade level, extracurriculars.
  - **Demographics:** Gender (for gender-specific scholarships), location (state/ZIP).
  - **Need:** FAFSA-style need (e.g. from assistance, financial need level, family size).
  - **School list:** Applications and interested schools for school-portal URLs and school-specific aid.
- **Output:** Only real opportunities with URLs; no loans (e.g. exclude Stafford, PLUS, private loans by keyword and type); no placeholders. Match score must meet or exceed the slider.

### 2.3 Government, Health, Special Needs, ECF crawlers

- **Profile usage:** Use full profile (location, demographics, health, assistance, family, military, etc.) to build search strategies and score results. No result should be returned below the slider percentage unless it is an explicitly allowed directory entry.
- **Real + relatable:** Every item must have a URL and must be relatable to the profile (scored). No placeholders; no loans; no matching funds.

### 2.4 Geo Crawler

- **Goal:** Find **every** real (URL-required) funding source that has an address or association **in a given ZIP code**, for **every US ZIP code** (nationwide). Not profile-based.
- **Storage:** Store in `funding_opportunities`; associate to geography via `funding_opportunity_geo_index` (state, ZIP, county, geo_run_id). Funding Opportunities tab must list geo results **grouped by state**, **sub-categorized by ZIP** (state → ZIP ordering).
- **Counts:** Do not cap by profile or relevance. Rural ZIPs may have 3; dense urban ZIPs may have many more. Persist all that are real (URL) and not loans/matching funds.
- **No placeholders / loans / matching funds:** Same as above: only real URLs; exclude loans and matching-fund programs.

---

## 3. Technical constraints to enforce

- **URL validation:** Before persisting or returning any opportunity, ensure at least one of `url`, `source_url`, or `application_url` is a valid http/https URL. Reject or drop otherwise.
- **Placeholder filtering:** Treat as invalid any URL containing `example.com`, `example.org`, or `placeholder`. Do not surface these in Discover or Funding Opportunities.
- **Loan / matching exclusion:** In crawlers and in listing APIs, exclude by:
  - **Keywords:** loan, microloan, financing, APR, matching funds, match required, cost share, 1:1 match, dollar-for-dollar, etc.
  - **Schema:** `opportunity_type` in loan types; `is_loan = true`; `requires_match = true` where the product rule is to hide matching-fund-only opportunities.
- **Slider:** The value from the Discover Grants “Minimum match score” slider is sent as `min_match_score` to `/api/real-crawlers/run`. Every crawler that returns scored results must filter so that returned opportunities have `match_score >= min_match_score`, except for allowed directory entries that are always shown.
- **Profile context:** When running profile-based crawlers, pass the full profile context (from `getProfileWithLocation` / `buildProfileFacets` / `requireFacets`) and use it for keywords, strategies, and scoring. Do not ignore sections or signals that could improve relevance.

---

## 4. Funding Opportunities tab

- **Data source:** `GET /api/opportunities` (from `funding_opportunities` and, when applicable, `funding_opportunity_geo_index`).
- **Geo display:** When showing geo-crawl results (e.g. filter by `comprehensive_crawler` or geo_run_id), order/group by **state**, then by **ZIP** within state, so the catalog is “by state, sub-categorized by ZIP.”
- **No placeholders:** Do not show opportunities without a valid URL; filter or hide them in the UI if they appear in the API.

---

## 5. What to do when editing crawler code

1. **Before changing any crawler:** Confirm how profile data flows in (sections, signals, facets) and that the slider value (`min_match_score`) is used in filtering.
2. **Before adding or returning an opportunity:** Ensure it has a valid URL; ensure it is not a loan or matching fund; ensure it meets the minimum match score (or is an allowed directory exception).
3. **Local crawler:** Verify 25-mile radius from profile ZIP and from each interested-school ZIP; verify school ZIPs come from profile (university_applications, education.interested_schools).
4. **Student crawler:** Verify school portals, FAFSA-style need, GPA, test scores, gender, and location are all used for discovery and scoring.
5. **Geo crawler:** Verify it runs over every US ZIP (when no state/zip_list filter); verify storage uses state and ZIP (geo index); verify no profile is used and no cap on count per ZIP except what’s real.
6. **After changes:** Run the crawler against at least one profile (and for Geo, run over a small ZIP set) and confirm results are real (URL), non-loan, non-matching, and (for profile crawlers) at or above the chosen slider percentage.

---

## 6. Short “rules” summary (for Cursor rules)

- All funding results must have a valid URL; no placeholders, no loans, no matching funds.
- Profile-based crawlers use full profile data and respect the Discover Grants minimum match score slider.
- Local crawler: 25 miles from profile ZIP and from each interested-school ZIP (students).
- Student crawler: school portals, FAFSA-style need, GPA, test scores, gender, location; endowments/grants/scholarships only.
- Geo crawler: every ZIP nationwide; real (URL) only; store by state and ZIP; not profile-based.
- Funding Opportunities: geo results grouped by state, sub-categorized by ZIP.

Use this master prompt when optimizing or fixing GrantFlow crawlers so that behavior meets or exceeds these goals.
