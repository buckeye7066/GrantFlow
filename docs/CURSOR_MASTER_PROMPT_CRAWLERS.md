# GrantFlow Crawlers — Master Prompt for Cursor

Use this as a **Cursor rule** or **master prompt** when working on GrantFlow crawlers.

**How to use:** Paste into a Cursor rule (e.g. `.cursor/rules/crawlers.mdc`) or into the chat when asking Cursor to optimize or fix crawlers. It encodes the product goals, architecture, and constraints so that all crawler-related changes meet or exceed them.

**Unified reference (implementation, tests, env):** [docs/CRAWLERS.md](CRAWLERS.md)

---

## 1. Architecture (current)

```
crawlerManager.js                 ← Entry point: runCrawler(db, profileId)
  ├── profileAnalyzer.js          ← Extracts 200+ signals from profile sections
  │     outputs: needs, demographics, health, family, military,
  │              occupation, immigration, geographic, income,
  │              education, interests, sports, schools[], keywords
  ├── matchEngine.js              ← Scores programs 0-100 against profile
  │     dimensions: category, state, applicantType, demographic,
  │                 health, military, family, student, interest,
  │                 school, occupation, immigration, geo, financial
  ├── generateSchoolCards()       ← Per-school funding cards from university
  │     (built into crawlerManager)   application portals, contacts, dept contacts
  ├── opportunityPolicy.js        ← URL validation, loan/matching-fund exclusion
  └── data/
       ├── federalBenefits.js     ← 27 federal programs
       ├── nationalPrograms.js    ← 44 national nonprofits & resource programs
       ├── scholarships.js        ← 46 scholarships (federal, national, field, athletic, demographic)
       ├── stateRegistry.js       ← 51 entries (50 states + DC) with metadata, HCBS waivers
       ├── stateBase.js           ← Auto-generates 12 programs per state from registry
       └── states/
            ├── _TEMPLATE.js      ← Copy for each new dedicated state file
            ├── WV.js             ← West Virginia (16 programs + county contacts)
            └── TN.js             ← Tennessee (17 programs + ECF/CHOICES + MCO contacts)
```

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
| `portals.counseling_url` | Counseling & Advising card |
| `portals.transcripts_url` / `send_scores_url` | Transcript & Score Submission card |
| `department_contacts[]` | Per-department cards filtered by student interests + gender |
| `contacts[]` | Contact info attached to Financial Aid / Admissions cards |
| `fafsa_code`, `tuition`, `financial_aid_deadline` | Included in card descriptions |

Cards are always generated (at least the Financial Aid card) even when portal URLs are not yet filled in — the card prompts the user to add the URL.

---

## 2. Core principles

- **Real only:** Every funding source must have a valid, clickable http/https URL. No placeholders (`example.com`, `example.org`, `TBD`). Drop any opportunity that lacks a URL before it reaches the UI or DB.
- **No loans, no matching funds:** Never surface loans, microloans, financing, or matching-fund/cost-share opportunities as grants. Exclude by keyword and schema (`opportunity_type`, `is_loan`, `requires_match`).
- **Profile-driven:** All crawlers use **all available profile data** (200+ fields from `profileAnalyzer`) to find and score funding. The `profileAnalyzer` extracts from every section: `basic_information`, `health_medical`, `medical_history`, `family_life`, `military_service`, `education`, `financial_information`, `government_assistance`, `location_focus`, `occupation`, `employment`, `narrative`, `comprehensive_application`, `demographics`, `university_applications`, `housing`, `nonprofit_compliance`, `small_business_details`.
- **Slider is law:** The minimum match score from the Discover Grants slider (`min_match_score`) must be respected. **Exceptions:** ECF and similar state benefit programs (eligibility-based only, no slider); directory-style resources always shown.
- **Score, don't discard:** Profile attribute mismatches reduce score — they do not eliminate results. `null`/`undefined`/missing fields default to neutral, not exclusionary. Zero results is a failure state.
- **School portals are data sources:** Every portal URL, contact, and department contact stored in a university application card must be surfaced as a funding opportunity card when relevant.

---

## 3. Per-crawler goals

### 3.1 Curated Benefits (`curated_benefits`)

The primary crawler. Uses `crawlerManager.runCrawler()`:
- Loads federal + state + national + scholarship programs
- Runs `matchEngine.matchPrograms()` against profile analysis
- Generates per-school cards from `university_applications`
- Stores results in `crawl_results` and `funding_opportunities`

### 3.2 Student / School Crawler

- **Sources:** School financial-aid portals from `university_applications` cards, FAFSA signals, curated scholarships
- **Profile usage:** GPA, SAT/ACT, intended major, grade level, extracurriculars, gender (for gender-specific scholarships), interests, sports, school ZIP/state, first-generation status
- **School card data used:** `portals.financial_aid_url`, `fafsa_code`, `contacts` (Financial Aid Office), `department_contacts` (matched to interests with gender awareness), `tuition`, `financial_aid_deadline`
- **Output:** Real opportunities with URLs; no loans; match score respects slider

### 3.3 ECF and similar state benefit programs

- **Eligibility-based, no slider:** Profile qualifies (e.g. ECF participant/caregiver/provider in TN) or does not. If qualified, return all non-loan benefits.
- **HCBS waivers in all states:** `stateRegistry.js` contains the ECF CHOICES equivalent for every state. `stateBase.js` auto-generates the HCBS waiver card per state.

### 3.4 Geo Crawler

- **Goal:** Find every real (URL-required) funding source per ZIP code nationwide. Not profile-based.
- **Storage:** `funding_opportunities` + `funding_opportunity_geo_index` (state, ZIP, county)
- **No placeholders / loans / matching funds.**

---

## 4. Profile analyzer signals

The `profileAnalyzer.analyzeProfile()` output drives all matching:

| Signal group | Examples |
|---|---|
| `needs` (Set) | utilities, housing, food, healthcare, disability, education, scholarship, legal, employment, cash_assistance |
| `demographics` (Set) | female, male, senior, young_adult, minor_child, veteran, first_generation, asian_american |
| `health` (Set) | disability, physical_disability, developmental_disability, intellectual_disability, cancer_survivor, tbi, mental_health_condition, wheelchair_user, substance_recovery |
| `family` (Set) | single_parent, homeless, domestic_violence_survivor, foster_youth, trafficking_survivor, disaster_survivor, grandparent_raising_grandchildren |
| `military` (Set) | veteran, disabled_veteran, active_duty_military, national_guard, military_dependent, gold_star_family |
| `occupation` (Set) | healthcare_worker, educator, firefighter, law_enforcement, small_business_owner, farmer |
| `immigration` (Set) | permanent_resident, refugee, new_immigrant |
| `geographic` (Set) | rural, appalachian, urban_underserved |
| `income` (Object) | belowPovertyLine, householdIncome |
| `education` (Object) | level, targetColleges, intendedMajor, gpa, act, sat, schoolZips, schoolStates, firstGeneration, stemStudent |
| `interests` (Set) | From extracurriculars, achievements, focus areas, career goals |
| `sports` (Set) | With gender from demographics for gender-specific matching |
| `schools` (Array) | Per-school objects with portals, contacts, departmentContacts, interests, fafsaCode, tuition |
| `keywords` (Array) | Aggregated raw text for keyword-based fallback matching |

---

## 5. Match engine scoring dimensions

`matchEngine.scoreProgram()` evaluates each program against the profile on up to 12 dimensions (max 100 points):

1. **Category match** (15 pts) — program categories vs. profile needs; keyword fallback if no direct overlap
2. **State match** (10 pts) — resident state or national
3. **Applicant type** (5 pts) — individual, student, organization, family
4. **Demographic match** (5 pts) — age, gender, ethnic signals
5. **Health match** (10 pts) — disability, conditions, medical needs
6. **Military match** (10 pts) — veteran, active duty, dependent
7. **Family match** (5 pts) — single parent, foster, homeless, DV
8. **Student match** (10 pts) — GPA, test scores, major, first-gen
9. **Interest/sport match** (5 pts) — extracurricular, athletic, gender-aware
10. **Occupation match** (5 pts) — healthcare worker, educator, first responder
11. **Immigration match** (5 pts) — refugee, permanent resident
12. **Geographic match** (5 pts) — rural, Appalachian, urban underserved
13. **Financial match** (5 pts) — income-based, below poverty line

Programs that hard-require a signal the profile lacks return `null` (excluded). Otherwise score is computed and normalized to 0-100%.

---

## 6. Technical constraints

- **URL validation:** Before persisting or returning, ensure at least one of `url`, `source_url`, `application_url` is valid http/https. Use `opportunityPolicy.isValidRealUrl()`.
- **Loan / matching exclusion:** Use `opportunityPolicy.isLoanLike()` and `isMatchingFunds()`. Exclude by keywords (loan, microloan, APR, matching funds, cost share, etc.) and schema flags.
- **Slider:** Sent as `min_match_score` to `/api/real-crawlers/run`. Filter returned results >= threshold. If 0 results meet threshold but matches exist, fall back to showing best available with a message.
- **DB storage:** Results go to both `crawl_results` (per-profile crawl log) and `funding_opportunities` (clickable cards). School portal cards use `source = 'school_portal'`, `type = 'DIRECTORY'`.
- **Record origin values** (CHECK constraint): `live_crawl`, `curated_verified`, `manual`, `synthetic`, `funding_api`, `url_import`, `directory_resource`, `directory:health_resources`, `directory:student_grants`, `discovered`, `geo_crawl`, `seeded`, `imported`.
- **Type values** (CHECK constraint): `OPPORTUNITY`, `PROGRAM`, `DIRECTORY`.

---

## 7. Adding states

**Option A — Dedicated file (rich data):** Copy `data/states/_TEMPLATE.js` → `{XX}.js`, fill in programs and county contacts. Loaded automatically by `crawlerManager.loadStateData()`.

**Option B — Registry entry (auto-generated):** Ensure `stateRegistry.js` has the state's entry with `benefitsPortal`, `tanfName`, `medicaidUrl`, `hcbsWaiver` (name, description, url, agency), `housingUrl`. `stateBase.js` auto-generates 12 programs. All 51 entries (50 states + DC) already exist.

Dedicated files take priority — if `states/OH.js` exists, it overrides the auto-generated OH programs.

---

## 8. What to do when editing crawler code

1. **Before changing any crawler:** Confirm how profile data flows in (profileAnalyzer sections → analysis object → matchEngine) and that `min_match_score` is used in filtering.
2. **Before adding or returning an opportunity:** Ensure it has a valid URL, is not a loan or matching fund, and meets minimum match score (or is a directory exception).
3. **School card changes:** Verify `generateSchoolCards()` reads all portal/contact fields from `analysis.schools[]`. When portals are filled in, cards use direct URLs; when empty, cards use search fallback + prompt to add portal.
4. **State additions:** Prefer adding to `stateRegistry.js` (immediate 12-program coverage) unless the state needs custom programs or county contacts.
5. **After changes:** Run against at least one profile end-to-end. Confirm multiple funding sources return, results are real (URL), non-loan, and counts are non-zero.

---

## 9. Short rules summary (for Cursor rules)

- All results must have a valid URL; no placeholders, no loans, no matching funds.
- Profile-based crawlers use full profile data (200+ signals) and respect the Discover Grants minimum match score slider, except ECF-style programs (eligibility-based only).
- School portal cards: generated for every target school using portals, contacts, and department contacts from university application cards. Always at least a Financial Aid card per school.
- State programs: dedicated file (WV, TN) or auto-generated from stateRegistry (all other states, 12 programs each including HCBS/I-DD waiver).
- Score, don't discard: mismatches reduce score; null fields are neutral; zero results is a failure.
- Geo crawler: every ZIP nationwide; real URLs only; store by state and ZIP; not profile-based.
