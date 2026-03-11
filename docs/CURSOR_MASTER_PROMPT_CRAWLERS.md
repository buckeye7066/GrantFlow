# GrantFlow Crawlers — Master Prompt for Cursor

Use this as a **Cursor rule** or **master prompt** when working on GrantFlow crawlers.

**How to use:** Paste into a Cursor rule (e.g. `.cursor/rules/crawlers.mdc`) or into the chat when asking Cursor to optimize or fix crawlers. It encodes the product goals, architecture, and constraints so that all crawler-related changes meet or exceed them.

**Unified reference (implementation, tests, env):** [docs/CRAWLERS.md](CRAWLERS.md)

---

## 1. Architecture (current)

```
crawlerManager.js                   ← Entry point: runCrawler(db, profileId, { crawlerType })
  ├── profileSignals/index.js       ← Canonical profile signal pipeline (NO data loss)
  │     loads: profile + all sections + tags + story/goals
  │     outputs: signals, intents, assistancePrograms, rawInputs
  ├── strategyRegistry.js           ← Per-crawler-type strategy config
  │     maps crawlerType → candidateSources, hardGates, needEmphasis,
  │                        intentBoost, urlPolicy, scoringWeights,
  │                        categoryFilter, maxResults, minScore
  ├── matchEngine.js                ← Scores programs 0-100 against profile
  │     dimensions: category, intent, state, applicantType, demographic,
  │                 health, military, family, student, interest,
  │                 school, occupation, immigration, geo, financial
  │     adds: match_explain on every result
  ├── needTaxonomy.js               ← Expands free-text needs into synonyms +
  │                                    mustTerms + programCategories
  ├── opportunityPolicy.js          ← URL validation, loan/matching-fund exclusion
  ├── generateSchoolCards()         ← Per-school funding cards (built into crawlerManager)
  └── data/
       ├── federalBenefits.js       ← 27 federal programs
       ├── nationalPrograms.js      ← 44 national nonprofits & resource programs
       ├── businessPrograms.js      ← 25 small business / microenterprise programs
       ├── scholarships.js          ← 46 scholarships (federal, national, field, athletic, demographic)
       ├── stateRegistry.js         ← 51 entries (50 states + DC) with metadata, HCBS waivers
       ├── stateBase.js             ← Auto-generates 12 programs per state from registry
       └── states/
            ├── _TEMPLATE.js        ← Copy for each new dedicated state file
            ├── WV.js               ← West Virginia (16 programs + county contacts)
            └── TN.js               ← Tennessee (17 programs + ECF/CHOICES + MCO contacts)
```

### Pipeline flow

1. **Profile → profileSignals** — loads ALL profile data, normalises into canonical `Signals` object, derives intents, extracts assistance programs, preserves `rawInputs` for debugging
2. **Strategy registry** — selects candidate sources, scoring rules, hard gates, URL policy based on `crawlerType`
3. **Candidate loading** — loads curated data per strategy (federal, state, national, business, scholarships, school cards)
4. **Match engine** — scores each candidate 0-100 with `match_explain` on every result
5. **URL policy enforcement** — strict/relaxed per strategy; demotes results without valid URLs
6. **Storage** — persists to `crawl_results` + `funding_opportunities`
7. **Debug/observability** — returns timing, match stats, candidate counts, PII-redacted rawInputs

### State program loading (crawlerManager.loadStateData)

1. **Dedicated file first** — if `states/{XX}.js` exists, use it (WV, TN)
2. **Auto-generate fallback** — if the state is in `stateRegistry.js`, call `generateStatePrograms(XX)` to produce 12 baseline programs (benefits portal, SNAP, TANF, Medicaid, LIHEAP, Weatherization, HCBS/I-DD waiver, I/DD agency, housing authority, vocational rehab, childcare assistance, 211)
3. **Federal/national only** — if neither exists

### School portal cards (crawlerManager.generateSchoolCards)

For **every** school in the student's `university_applications`, the crawler generates funding opportunity cards using data from the school's card:

| Field in school card | What the crawler produces |
|---|---|
| `portals.financial_aid_url` | **Financial Aid card** (direct link or Google search fallback) |
| `portals.admissions_url` | Admissions Portal card |
| `department_contacts[]` | Per-department cards filtered by student interests + gender |
| `contacts[]` | Contact info attached to Financial Aid / Admissions cards |
| `fafsa_code`, `tuition`, `financial_aid_deadline` | Included in card descriptions |

---

## 2. Core principles

- **Real only:** Every funding source must have a valid, clickable http/https URL. No placeholders (`example.com`, `example.org`, `TBD`). Drop any opportunity that lacks a URL before it reaches the UI or DB.
- **No loans, no matching funds:** Never surface loans, microloans, financing, or matching-fund/cost-share opportunities as grants. Exclude by keyword and schema (`opportunity_type`, `is_loan`, `requires_match`).
- **Profile-driven:** All crawlers use the canonical **profileSignals** module — never duplicate extraction logic. ProfileSignals extracts from every section: `basic_information`, `health_medical`, `medical_history`, `family_life`, `military_service`, `education`, `financial_information`, `government_assistance`, `location_focus`, `occupation`, `employment`, `narrative`, `comprehensive_application`, `demographics`, `university_applications`, `housing`, `nonprofit_compliance`, `small_business_details`.
- **Strategy-routed:** Every `crawler_type` maps to a strategy that determines candidate sources, scoring weights, hard gates, and URL policy. No two crawlers behave identically.
- **Match explainability:** Every returned result MUST include `match_explain` with `matchedSignals`, `matchedNeeds`, `matchedNeedTerms`, `scoreBreakdown`, `urlPolicy`.
- **Slider is law:** The minimum match score from the Discover Grants slider (`min_match_score`) must be respected. **Exceptions:** ECF and similar state benefit programs (eligibility-based only, no slider); directory-style resources always shown.
- **Score, don't discard:** Profile attribute mismatches reduce score — they do not eliminate results. `null`/`undefined`/missing fields default to neutral, not exclusionary. Zero results is a failure state.

---

## 3. Strategy Registry

### 3.1 Available strategies

| `crawler_type` | Candidate sources | Hard gates | URL policy |
|---|---|---|---|
| `comprehensive` | federal, state, national, business, scholarships, schoolCards | none | strict |
| `local_funding` | state, national | none | strict |
| `government_funding` | federal, state | none | strict |
| `student_grants` | scholarships, national, schoolCards | requires education intent | strict |
| `health_resources` | national | requires healthcare intent | strict |
| `special_needs` | national, federal | none (category filter: disability, special_needs, healthcare) | strict |
| `ecf_benefits` | state, national | none | relaxed |
| `curated_benefits` | federal, state, national, business, scholarships | none | strict |
| `item_matching` | federal, national, business | none | strict |

### 3.2 Hard gates

When a strategy has hard gates, the crawler checks whether the profile's intents include the required signal. If not, the response returns `gated: true` with a reason — no junk results are produced.

---

## 4. Profile signals

The `profileSignals/index.js` module is the single source of truth. It wraps `profileHelpers.loadProfileContext` and adds:

- **`deriveIntents`** — maps signals to intent buckets: `business`, `education`, `healthcare`, `housing`, `workforce`, `military`
- **`extractAssistancePrograms`** — detects SNAP, Medicaid, Section 8, TANF, etc. from profile data
- **`buildRawInputs`** — PII-safe subset for debugging (redacted before logging)

### Signal groups

| Signal group | Examples |
|---|---|
| `needs` (Set) | utilities, housing, food, healthcare, disability, education, scholarship, legal, employment, cash_assistance, business |
| `demographics` (Set) | female, male, senior, young_adult, minor_child, veteran, first_generation, asian_american |
| `health` (Set) | disability, physical_disability, developmental_disability, cancer_survivor, tbi, mental_health_condition |
| `family` (Set) | single_parent, homeless, domestic_violence_survivor, foster_youth |
| `military` (Set) | veteran, disabled_veteran, active_duty_military, national_guard, military_dependent |
| `occupation` (Set) | healthcare_worker, educator, small_business_owner, farmer |
| `immigration` (Set) | permanent_resident, refugee, new_immigrant |
| `geographic` (Set) | rural, appalachian, urban_underserved |
| `income` (Object) | belowPovertyLine, householdIncome |
| `education` (Object) | level, targetColleges, intendedMajor, gpa, act, sat, schoolZips, schoolStates, firstGeneration |
| `interests` (Set) | From extracurriculars, achievements, focus areas, career goals |
| `sports` (Set) | With gender from demographics for gender-specific matching |
| `schools` (Array) | Per-school objects with portals, contacts, departmentContacts |
| `keywords` (Array) | Aggregated raw text for keyword-based fallback matching |

---

## 5. Match engine scoring

`matchEngine.scoreProgram()` evaluates each program on up to 12 dimensions (max ~100 points):

1. **Category match** (40 pts) — program categories vs. profile needs; keyword fallback
2. **Intent alignment** (25 pts) — intentMatch tags vs. derived profile intents
3. **State match** (20 pts) — resident state or national
4. **Applicant type** (10 pts) — individual, student, organization, family
5. **Demographic match** (10 pts) — age, gender, ethnic signals
6. **Health match** (10 pts) — disability, conditions, medical needs
7. **Military match** (5 pts) — veteran, active duty, dependent
8. **Family match** (5 pts) — single parent, foster, homeless, DV
9. **Student match** (10 pts) — GPA, test scores, major, first-gen
10. **Interest/sport match** (10 pts) — extracurricular, athletic, gender-aware
11. **Occupation match** (5 pts) — healthcare worker, educator, first responder
12. **Immigration match** (5 pts) — refugee, permanent resident
13. **Geographic match** (5 pts) — rural, Appalachian, urban underserved
14. **Financial match** (5 pts) — income-based, below poverty line

**Negative matching:** Programs requiring specific health conditions (cancer, kidney disease, visual impairment, etc.) return `null` for non-matching profiles. This prevents irrelevant health programs from appearing.

**Deduplication:** By ID, by canonical URL, and by normalized name.

**Informational page filtering:** CDC topics, MedlinePlus, WebMD, etc. are excluded.

---

## 6. Need Taxonomy

`needTaxonomy.js` expands free-text needs into structured search terms:

| Need | Canonical | Example synonyms |
|---|---|---|
| "emergency rent" | housing | rental assistance, arrears, eviction prevention, rapid rehousing |
| "PROBE class" | employment | workforce training, WIOA, licensure, certification |
| "utility shutoff" | utilities | LIHEAP, energy assistance, shutoff prevention |
| "small business" | business | microenterprise, SBA, self-employment |
| "medical bills" | medical | charity care, patient assistance, copay assistance |

Used by `POST /api/real-crawlers/specific-need` endpoint.

---

## 7. Observability

Every crawler run produces a `debug` object in the response:

```json
{
  "strategy": "comprehensive",
  "gated": false,
  "intents": ["housing", "workforce"],
  "candidateCounts": { "federal": 27, "state": 12, "national": 44 },
  "totalCandidates": 83,
  "matchedCount": 42,
  "demotedForUrl": 0,
  "matchStats": {
    "dupId": 0, "dupUrl": 3, "dupName": 0,
    "informational": 2, "excluded": 4,
    "nullScore": 30, "belowMin": 0
  },
  "timing": {
    "signalLoad_ms": 5,
    "candidateLoad_ms": 2,
    "matching_ms": 8,
    "storage_ms": 15,
    "total_ms": 30
  }
}
```

PII is redacted from `rawInputs` before inclusion in the debug response. Logs are structured and concise for Vercel.

---

## 8. Testing

### Unit tests (golden fixtures)

`tests/unit/golden-crawlers.test.mjs` — 43 tests across 7 suites:

- **Strategy Registry** — all types have strategies, gates work
- **Need Taxonomy** — expansion and scoring
- **Golden Profiles (Comprehensive)** — 8 fixture profiles, all return results with URLs and match_explain
- **Golden Profiles (Strategy-specific)** — intent-based scoring, gating, graceful degradation
- **Negative Matching** — excluded conditions
- **Deduplication** — URL-based collapse
- **Specific Need Scoring** — need-to-program matching

### Policy tests

- `tests/unit/opportunityPolicy.test.mjs` — 55 tests for URL validation, loan/matching-fund exclusion, placeholder detection
- `tests/unit/real-crawlers-policy.test.mjs` — integration tests with real server

### Production verification

`scripts/verify-crawlers-prod.mjs` — hits deployed endpoints, validates:
- Each crawler type returns count > 0 (or `gated`)
- 100% URL rate for funding sources
- 100% `match_explain` rate
- Specific-need endpoint returns results for "emergency rent"
- Exits non-zero on any failure

---

## 9. API Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/real-crawlers/run` | Run single crawler for profile |
| `POST` | `/api/real-crawlers/run-multiple` | Run multiple crawlers |
| `POST` | `/api/real-crawlers/specific-need` | Search by free-text need |
| `GET` | `/api/real-crawlers/list` | List available crawlers |
| `GET` | `/api/real-crawlers/strategies` | List strategy configs + gates |
| `GET` | `/api/real-crawlers/health-check` | System health |
| `GET` | `/api/real-crawlers/find-profile` | Diagnostic: find profile by name |

---

## 10. Adding states

**Option A — Dedicated file (rich data):** Copy `data/states/_TEMPLATE.js` → `{XX}.js`, fill in programs and county contacts. Loaded automatically by `crawlerManager.loadStateData()`.

**Option B — Registry entry (auto-generated):** Ensure `stateRegistry.js` has the state's entry with `benefitsPortal`, `tanfName`, `medicaidUrl`, `hcbsWaiver` (name, description, url, agency), `housingUrl`. `stateBase.js` auto-generates 12 programs. All 51 entries (50 states + DC) already exist.

Dedicated files take priority — if `states/OH.js` exists, it overrides the auto-generated OH programs.

---

## 11. What to do when editing crawler code

1. **Before changing any crawler:** Confirm how profile data flows in (profileSignals → analysis object → strategyRegistry → matchEngine) and that `min_match_score` is used in filtering.
2. **Before adding or returning an opportunity:** Ensure it has a valid URL, is not a loan or matching fund, and meets minimum match score (or is a directory exception).
3. **Never duplicate profile extraction:** All crawlers MUST use `profileSignals/index.js`. Direct profile extraction from routes is forbidden.
4. **Always include match_explain:** If a new scoring dimension is added, update `scoreProgram` to include it in `match_explain.scoreBreakdown`.
5. **School card changes:** Verify `generateSchoolCards()` reads all portal/contact fields from `analysis.schools[]`.
6. **State additions:** Prefer adding to `stateRegistry.js` (immediate 12-program coverage) unless the state needs custom programs or county contacts.
7. **After changes:** Run `node --test tests/unit/golden-crawlers.test.mjs` (43 tests) and `node --test tests/unit/opportunityPolicy.test.mjs` (55 tests). All must pass.

---

## 12. Short rules summary (for Cursor rules)

- All results must have a valid URL; no placeholders, no loans, no matching funds.
- Every result MUST include `match_explain`. Missing `match_explain` is a test failure.
- Profile-based crawlers use the canonical `profileSignals` module — never duplicate extraction.
- Each `crawler_type` is strategy-routed with distinct candidate sources, gates, and scoring.
- School portal cards: generated for every target school using portals, contacts, and department contacts from university application cards.
- State programs: dedicated file (WV, TN) or auto-generated from stateRegistry (all other states, 12 programs each including HCBS/I-DD waiver).
- Score, don't discard: mismatches reduce score; null fields are neutral; zero results is a failure.
- Negative rules exclude clearly irrelevant programs (cancer programs for non-cancer profiles, etc.).
- Specific-need search expands free text via needTaxonomy and blends profile + need scores.
- Debug response includes timing, match stats, candidate counts, and PII-redacted rawInputs.
