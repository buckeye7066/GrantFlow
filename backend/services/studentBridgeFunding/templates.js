/**
 * studentBridgeFunding/templates.js
 *
 * Catalog of off-campus-living / move-in / emergency-bridge funding templates
 * for student profiles. Each template renders to an opportunity_data block
 * with deadline, sponsor, URL, description tied to the student's actual
 * Fall enrollment cycle (resolved by calendar.js).
 *
 * Categories (in priority order):
 *   1. UNIVERSAL  — every student gets these (FAFSA, Pell, FSEOG, Direct Loan,
 *                   Work-Study, Modest Needs, generic 211 referral).
 *   2. STATE      — state-grant programs (HOPE, TOPS, Bright Futures, …),
 *                   state housing-finance agency, state LIHEAP. Only the state
 *                   the student is enrolling in.
 *   3. SCHOOL     — institutional emergency fund / one-stop cash advance /
 *                   off-campus housing portal — only for the resolved school.
 *   4. COUNTY     — local emergency rent + utility funders for the COLLEGE
 *                   county AND the HOME county (pre-move).
 *
 * Every template must:
 *   - render `application_url` to a real, working URL (no Google searches).
 *   - render `source` to a value present in pipelineAllowedSources.js.
 *   - tag itself with `category` so the expander/UI can group it.
 *   - either return null (no-op for this profile) or a complete opportunity.
 *
 * Sources verified May 2026.
 */

const SCHOOL_FALLBACK_PORTALS = (school) => {
  if (!school) return null
  const base = (school.website || '').replace(/\/$/, '')
  if (!base) return null
  return {
    deanOfStudentsEmergencyFund: `${base}/dean-of-students/emergency-fund`,
    oneStop: `${base}/one-stop`,
    financialAid: `${base}/financial-aid`,
    offCampusHousing: `${base}/housing/off-campus`,
  }
}

/**
 * Each template:
 *   id           - stable string for dedupe / metric tagging
 *   appliesIf    - (ctx) => boolean
 *   category     - opportunity category
 *   source       - PIPELINE_ALLOWED_SOURCES value
 *   matchScore   - 0..100
 *   build        - (ctx) => opportunity_data (or null to skip)
 *
 * ctx: { profile, sections, calendar, school, state, county, collegeTown,
 *        homeState, homeCounty, homeCity, today }
 */
export const STUDENT_BRIDGE_FUNDING_TEMPLATES = [
  // ──────────────────────────────────────────────────────────────────────
  // UNIVERSAL — every student needs these
  // ──────────────────────────────────────────────────────────────────────

  {
    id: 'universal-fafsa',
    category: 'federal_application_gateway',
    source: 'curated_benefits',
    matchScore: 100,
    appliesIf: () => true,
    build: ({ calendar }) => ({
      title: `FAFSA — Free Application for Federal Student Aid (${calendar.academicCycle})`,
      sponsor: 'U.S. Department of Education — Federal Student Aid',
      application_url: 'https://studentaid.gov/h/apply-for-aid/fafsa',
      description: `The FAFSA is the gateway for Pell Grant, FSEOG, Work-Study, state aid (HOPE/TOPS/etc.), AND most institutional need-based aid. The ${calendar.academicCycle} cycle is accepted through ${calendar.cycleDeadlines.fafsa_close}; school priority deadlines were typically ${calendar.cycleDeadlines.fafsa_priority}. File NOW to maximize grant aid for Fall ${calendar.enrollmentYear}.`,
      deadline: calendar.cycleDeadlines.fafsa_close,
      deadline_type: 'fixed',
      amount_min: null,
      amount_max: null,
      application_method: 'portal',
      applicationNote: `Grant refunds typically disburse to the school around ${calendar.refundWindow.start} and to the student bank account a few days later.`,
    }),
  },

  {
    id: 'universal-pell-grant',
    category: 'federal_grant',
    source: 'curated_benefits',
    matchScore: 90,
    appliesIf: () => true,
    build: ({ calendar }) => ({
      title: `Federal Pell Grant (${calendar.academicCycle})`,
      sponsor: 'U.S. Department of Education',
      application_url: 'https://studentaid.gov/understand-aid/types/grants/pell',
      description: `Need-based federal grant — does NOT need to be repaid. Maximum award for ${calendar.academicCycle} is ~$7,395. Disbursed via the school after FAFSA + enrollment confirmation; refund to student bank account typically ${calendar.refundWindow.start} to ${calendar.refundWindow.end}.`,
      deadline: null,
      deadline_type: 'rolling',
      amount_min: null,
      amount_max: 7395,
      application_method: 'portal',
      applicationNote: 'No separate application — eligibility flows from the FAFSA.',
    }),
  },

  {
    id: 'universal-fseog',
    category: 'federal_grant',
    source: 'curated_benefits',
    matchScore: 80,
    appliesIf: () => true,
    build: ({ calendar }) => ({
      title: `Federal Supplemental Educational Opportunity Grant (FSEOG) (${calendar.academicCycle})`,
      sponsor: 'U.S. Department of Education',
      application_url: 'https://studentaid.gov/understand-aid/types/grants/fseog',
      description: `Need-based federal grant ($100–$4,000/yr) for students with the lowest Expected Family Contribution. Awarded by the school's financial aid office on a first-come basis — file FAFSA EARLY to maximize odds. Disburses with the school's Title IV refund cycle.`,
      deadline: null,
      deadline_type: 'rolling',
      amount_min: 100,
      amount_max: 4000,
      application_method: 'portal',
    }),
  },

  // NO LOANS. Mission rule: GrantFlow never recommends funding sources that
  // require repayment. The Federal Direct Subsidized Loan was previously
  // listed here and was removed in favor of grant-only bridge funding
  // (Pell + FSEOG + Work-Study earnings + state HOPE + emergency rent funds).
  // If a future contributor needs to surface loan information for context,
  // do it as documentation in the Anya guidance UI — never as a pipeline grant.

  {
    id: 'universal-work-study',
    category: 'federal_employment',
    source: 'curated_benefits',
    matchScore: 70,
    appliesIf: () => true,
    build: ({ calendar, school }) => ({
      title: `Federal Work-Study${school?.name ? ` at ${school.name}` : ''} (${calendar.academicCycle})`,
      sponsor: 'U.S. Department of Education / participating school',
      application_url: school?.portals?.financialAid || 'https://studentaid.gov/understand-aid/types/work-study',
      description: 'Part-time on-campus or community-service jobs subsidized by federal aid. Earnings are paid as a paycheck (NOT applied to tuition), so the student can use them for off-campus rent and utilities. Most schools allow students to start working the first week of classes — first paycheck 1–2 weeks later.',
      deadline: null,
      deadline_type: 'rolling',
      amount_min: 1500,
      amount_max: 4000,
      application_method: 'portal',
      applicationNote: 'Indicate interest on FAFSA + apply for posted work-study positions through the school career portal.',
    }),
  },

  {
    id: 'universal-modest-needs',
    category: 'national_emergency_grant',
    source: 'curated_benefits',
    matchScore: 88,
    appliesIf: () => true,
    build: () => ({
      title: 'Modest Needs Foundation — Self-Sufficiency Grant',
      sponsor: 'Modest Needs Foundation',
      application_url: 'https://www.modestneeds.org/for-applicants/apply-for-help.asp',
      description: 'Up to $1,000 paid directly to a third party (landlord, utility company) for a documented short-term emergency. Average turnaround 2–4 weeks. Explicitly serves students transitioning to college housing — apply with documented rent or security-deposit shortfall AND proof of pending Fall financial aid.',
      deadline: null,
      deadline_type: 'rolling',
      amount_min: null,
      amount_max: 1000,
      application_method: 'portal',
    }),
  },

  // ──────────────────────────────────────────────────────────────────────
  // UNIVERSAL — 2-1-1 statewide referral hotline
  // ──────────────────────────────────────────────────────────────────────

  {
    id: 'universal-211',
    category: 'referral_hotline',
    source: 'curated_benefits',
    matchScore: 90,
    appliesIf: () => true,
    build: ({ collegeState, homeState }) => {
      const state = collegeState || homeState || 'US'
      const stateUrls = {
        TN: 'https://tn211.myresourcedirectory.com',
        GA: 'https://www.211georgia.org',
        FL: 'https://www.myflorida211.org',
        AL: 'https://www.211connectsalabama.org',
        KY: 'https://www.uwky.org/211',
        NC: 'https://nc211.org',
        SC: 'https://www.sc211.org',
        VA: 'https://www.211virginia.org',
        WV: 'https://www.wv211.org',
        OH: 'https://211.org',
        MS: 'https://www.211ms.org',
        MO: 'https://211missouri.org',
        AR: 'https://uwarkansas.org/211',
      }
      return {
        title: `${state === 'US' ? 'United Way' : state} 211 — Statewide Emergency Rental & Utility Referral`,
        sponsor: 'United Way 211',
        application_url: stateUrls[state] || 'https://www.211.org',
        description: `Calling 2-1-1 (or visiting the local 211 directory) is the single fastest way to reach every emergency rent / first-month / utility / move-in funder active in the student's ZIP code. 211 routes to county-level pots of money that aren't published anywhere else. Always contact within 48h of a documented housing shortfall.`,
        deadline: null,
        deadline_type: 'rolling',
        amount_min: null,
        amount_max: null,
        application_method: 'phone',
      }
    },
  },

  // ──────────────────────────────────────────────────────────────────────
  // STATE — only fired when state matches; expand with new states by adding
  // entries here. Each state-template is a SINGLE template that gates on
  // ctx.collegeState.
  // ──────────────────────────────────────────────────────────────────────

  {
    id: 'state-tn-hope',
    category: 'state_grant',
    source: 'state_grants_portal',
    matchScore: 92,
    appliesIf: ({ collegeState }) => collegeState === 'TN',
    build: ({ calendar }) => ({
      title: `Tennessee HOPE Scholarship (${calendar.academicCycle})`,
      sponsor: 'Tennessee Student Assistance Corporation (TSAC)',
      application_url: 'https://www.tn.gov/collegepays/tsac-student-portal.html',
      description: `Lottery-funded merit scholarship. ${calendar.academicCycle} freshman award ~$1,750/semester (4-yr) or $3,500/yr. Requires ACT 21 or 3.0 weighted HS GPA + Tennessee residency + FAFSA. Apply via TSAC Student Portal by ${calendar.cycleDeadlines.state_grant_app}.`,
      deadline: calendar.cycleDeadlines.state_grant_app,
      deadline_type: 'fixed',
      amount_min: null,
      amount_max: 7000,
      application_method: 'portal',
    }),
  },

  {
    id: 'state-tn-aspire',
    category: 'state_grant',
    source: 'state_grants_portal',
    matchScore: 90,
    appliesIf: ({ collegeState }) => collegeState === 'TN',
    build: ({ calendar }) => ({
      title: `Tennessee HOPE Aspire Award (${calendar.academicCycle})`,
      sponsor: 'Tennessee Student Assistance Corporation (TSAC)',
      application_url: 'https://www.tn.gov/collegepays/tsac-student-portal.html',
      description: `Need-based supplement to TN HOPE: extra $750/semester for adjusted family income ≤ $36,000. Eligibility set automatically by FAFSA SAI. Same TSAC application as HOPE — no separate form.`,
      deadline: calendar.cycleDeadlines.state_grant_app,
      deadline_type: 'fixed',
      amount_min: null,
      amount_max: 1500,
      application_method: 'portal',
    }),
  },

  {
    id: 'state-tn-tsaa',
    category: 'state_grant',
    source: 'state_grants_portal',
    matchScore: 85,
    appliesIf: ({ collegeState }) => collegeState === 'TN',
    build: ({ calendar }) => ({
      title: `Tennessee Student Assistance Award (TSAA) (${calendar.academicCycle})`,
      sponsor: 'Tennessee Student Assistance Corporation (TSAC)',
      application_url: 'https://www.tn.gov/collegepays/tsac-student-portal.html',
      description: `Need-based grant up to $4,000/yr for TN residents at participating in-state schools. First-come-first-served — funds frequently exhaust by midsummer. Priority date for ${calendar.academicCycle} was ${calendar.cycleDeadlines.state_aid_priority} but late applicants are still considered until funds run out — file FAFSA + TSAA application NOW.`,
      // Use rolling: first-come funds remain open after the priority date.
      deadline: null,
      deadline_type: 'rolling',
      amount_min: null,
      amount_max: 4000,
      application_method: 'portal',
      applicationNote: `Priority date ${calendar.cycleDeadlines.state_aid_priority} has passed but TSAA still accepts late filers until ${calendar.academicCycle} funds are exhausted.`,
    }),
  },

  {
    id: 'state-ga-hope',
    category: 'state_grant',
    source: 'state_grants_portal',
    matchScore: 90,
    appliesIf: ({ collegeState }) => collegeState === 'GA',
    build: ({ calendar }) => ({
      title: `Georgia HOPE Scholarship (${calendar.academicCycle})`,
      sponsor: 'Georgia Student Finance Commission',
      application_url: 'https://gafutures.org/hope-state-aid-programs/hope-zell-miller-scholarships/',
      description: 'Merit scholarship covering tuition at GA public colleges (or up to ~$4,690/yr at private GA schools). Requires 3.0 HS GPA + GA residency. Application via GAfutures.org and the FAFSA.',
      deadline: calendar.cycleDeadlines.state_grant_app,
      deadline_type: 'fixed',
      amount_min: null,
      amount_max: 7000,
      application_method: 'portal',
    }),
  },

  {
    id: 'state-fl-bright-futures',
    category: 'state_grant',
    source: 'state_grants_portal',
    matchScore: 90,
    appliesIf: ({ collegeState }) => collegeState === 'FL',
    build: ({ calendar }) => ({
      title: `Florida Bright Futures Scholarship (${calendar.academicCycle})`,
      sponsor: 'Florida Department of Education',
      application_url: 'https://www.floridastudentfinancialaidsg.org/SAPBFMAIN/SAPBFMAIN',
      description: 'Merit scholarship covering up to 100% of tuition + fees at FL public universities. Initial application via the Florida Financial Aid Application (FFAA) — separate from FAFSA. Tiers depend on ACT/SAT + GPA + service hours.',
      deadline: calendar.cycleDeadlines.state_grant_app,
      deadline_type: 'fixed',
      amount_min: null,
      amount_max: 7000,
      application_method: 'portal',
    }),
  },

  {
    id: 'state-la-tops',
    category: 'state_grant',
    source: 'state_grants_portal',
    matchScore: 90,
    appliesIf: ({ collegeState }) => collegeState === 'LA',
    build: ({ calendar }) => ({
      title: `Louisiana TOPS — Taylor Opportunity Program for Students (${calendar.academicCycle})`,
      sponsor: 'Louisiana Office of Student Financial Assistance (LOSFA)',
      application_url: 'https://mylosfa.la.gov/students/scholarships-grants/tops/',
      description: 'Tuition-coverage award for LA residents attending LA public universities. Tiers: TOPS Tech / Opportunity / Performance / Honors. Eligibility set by ACT + GPA + LA Core Curriculum completion. Apply via the FAFSA OR the Louisiana TOPS On-line application by July 1.',
      deadline: calendar.cycleDeadlines.state_grant_app,
      deadline_type: 'fixed',
      amount_min: null,
      amount_max: 9000,
      application_method: 'portal',
    }),
  },

  {
    id: 'state-housing-finance-thda',
    category: 'state_housing_assistance',
    source: 'state_portal',
    matchScore: 78,
    appliesIf: ({ collegeState }) => collegeState === 'TN',
    build: () => ({
      title: 'Tennessee Housing Development Agency (THDA) — Housing Stability / HOME-ARP',
      sponsor: 'Tennessee Housing Development Agency',
      application_url: 'https://thda.org/help-for-renters',
      description: 'THDA administers federal HOME-ARP rapid-rehousing funds for Tennesseans at risk of housing instability — including young adults transitioning to college housing without family financial backing. Apply through the regional sub-grantee for the student\'s county; THDA may pay first month + security deposit and connect to ongoing TBRA (up to 24 months).',
      deadline: null,
      deadline_type: 'rolling',
      amount_min: null,
      amount_max: null,
      application_method: 'portal',
    }),
  },

  {
    id: 'state-liheap',
    category: 'utility_assistance',
    source: 'liheap',
    matchScore: 80,
    appliesIf: ({ collegeState }) => Boolean(collegeState),
    build: ({ collegeState }) => {
      const stateUrls = {
        TN: 'https://www.tn.gov/humanservices/for-families/low-income-home-energy-assistance-program-liheap.html',
        GA: 'https://dfcs.georgia.gov/services/low-income-home-energy-assistance-program-liheap',
        FL: 'https://www.myflfamilies.com/service-programs/access/leap',
        AL: 'https://dhr.alabama.gov/services/low_income_home_energy_assistance_program/',
        KY: 'https://chfs.ky.gov/agencies/dcbs/dfs/eb/Pages/heap.aspx',
        NC: 'https://www.ncdhhs.gov/divisions/social-services/energy-assistance',
        SC: 'https://oeo.sc.gov/programs/energy-assistance',
        VA: 'https://www.dss.virginia.gov/community/eap.html',
        WV: 'https://dhhr.wv.gov/bcf/Programs/Pages/LIEAP.aspx',
        OH: 'https://development.ohio.gov/individual/energy-assistance',
        MS: 'https://www.mdhs.ms.gov/economic-assistance/liheap/',
        MO: 'https://mydss.mo.gov/energy-assistance',
        AR: 'https://humanservices.arkansas.gov/divisions-shared-services/county-operations/services-and-programs-administered/liheap/',
        TX: 'https://www.tdhca.texas.gov/community-affairs/ceap/',
        CA: 'https://www.csd.ca.gov/Pages/LIHEAP-Application.aspx',
        NY: 'https://otda.ny.gov/programs/heap/',
        IL: 'https://dceo.illinois.gov/communityservices/homeweatherization/liheap.html',
        PA: 'https://www.dhs.pa.gov/Services/Assistance/Pages/LIHEAP.aspx',
        CT: 'https://portal.ct.gov/dss/economic-security/winter-heating-assistance/winter-heating-assistance',
        MA: 'https://www.mass.gov/applying-for-fuel-assistance-liheap',
        NJ: 'https://www.nj.gov/humanservices/dfd/programs/liheap/',
      }
      const url = stateUrls[collegeState] || 'https://www.acf.hhs.gov/ocs/programs/liheap'
      return {
        title: `LIHEAP ${collegeState} — Home Energy Assistance Program`,
        sponsor: `${collegeState} Department of Human Services / LIHEAP`,
        application_url: url,
        description: 'Pays a portion of electric/gas/water bills directly to the utility company once the student has an active service account in their name. Cooling Assistance May–Aug; Heating Assistance Oct–Mar. Apply through the state intake agency for the student\'s college-town county.',
        deadline: null,
        deadline_type: 'rolling',
        amount_min: 200,
        amount_max: 1000,
        application_method: 'portal',
      }
    },
  },

  // ──────────────────────────────────────────────────────────────────────
  // SCHOOL — institutional emergency funds + cash advance + off-campus
  // ──────────────────────────────────────────────────────────────────────

  {
    id: 'school-dean-emergency-fund',
    category: 'emergency_student_aid',
    source: 'school_portal',
    matchScore: 95,
    appliesIf: ({ school }) => Boolean(school?.name),
    build: ({ school }) => {
      const portals = school.portals || SCHOOL_FALLBACK_PORTALS(school)
      const url = portals?.deanOfStudentsEmergencyFund
        || (school.website ? `${school.website.replace(/\/$/, '')}/dean-of-students/emergency-fund` : null)
      if (!url) return null
      return {
        title: `${school.name} — Dean of Students Student Emergency Fund`,
        sponsor: `${school.name} Office of the Dean of Students`,
        application_url: url,
        description: `Small one-time grants ($250–$2,500) for ${school.name} students experiencing immediate financial crisis — explicitly includes housing emergencies, security deposits, first-month-rent gaps, utility shut-off prevention, and food insecurity. Funds can be released within days. Apply once the student's institutional ID number is issued (after admission acceptance).`,
        deadline: null,
        deadline_type: 'rolling',
        amount_min: 250,
        amount_max: 2500,
        application_method: 'portal',
      }
    },
  },

  {
    id: 'school-one-stop-cash-advance',
    category: 'institutional_emergency_advance',
    source: 'school_portal',
    matchScore: 88,
    appliesIf: ({ school }) => Boolean(school?.name),
    build: ({ school }) => {
      const portals = school.portals || SCHOOL_FALLBACK_PORTALS(school)
      const url = portals?.oneStop || portals?.financialAid
        || (school.website ? `${school.website.replace(/\/$/, '')}/one-stop` : null)
      if (!url) return null
      return {
        title: `${school.name} — Financial Aid Cash Advance / Book Voucher`,
        sponsor: `${school.name} One Stop / Financial Aid Office`,
        application_url: url,
        description: `Most universities offer Pell-eligible students a Book/Personal-Expense voucher of $300–$750 disbursed at the start of August (against pending Title IV awards) and, in hardship cases, a short-term Cash Advance against the August refund. Use to cover late-July rent before the full refund hits. Request via the One Stop / Financial Aid office immediately after FAFSA + admission are confirmed.`,
        deadline: null,
        deadline_type: 'rolling',
        amount_min: 300,
        amount_max: 750,
        application_method: 'portal',
      }
    },
  },

  {
    id: 'school-off-campus-housing-portal',
    category: 'school_resource',
    source: 'school_portal',
    matchScore: 75,
    appliesIf: ({ school }) => Boolean(school?.portals?.offCampusHousing),
    build: ({ school }) => ({
      title: `${school.name} — Off-Campus Housing Portal`,
      sponsor: `${school.name} Department of Housing & Residential Life`,
      application_url: school.portals.offCampusHousing,
      description: `Official off-campus housing listing portal vetted by ${school.name}. Lists landlord contact info, pricing, lease terms for properties near campus. Many institutions partner with the listing service to flag properties that accept the institutional housing voucher / direct-bill the student account.`,
      deadline: null,
      deadline_type: 'rolling',
      amount_min: null,
      amount_max: null,
      application_method: 'portal',
    }),
  },

  // ──────────────────────────────────────────────────────────────────────
  // COUNTY — local emergency funders for the COLLEGE county AND HOME county
  // ──────────────────────────────────────────────────────────────────────

  {
    id: 'county-united-way-college-town',
    category: 'local_emergency_assistance',
    source: 'community_foundation',
    matchScore: 85,
    appliesIf: ({ collegeCounty }) => Boolean(collegeCounty),
    build: ({ collegeCounty, collegeState }) => ({
      title: `United Way of ${collegeCounty} — Emergency Financial Assistance`,
      sponsor: `United Way of ${collegeCounty}, ${collegeState || ''}`.trim().replace(/,$/, ''),
      application_url: 'https://www.unitedway.org/find-your-united-way',
      description: `Most United Ways operate an Emergency Financial Assistance Program funded by community donors that covers first-month rent, security deposit, and utility connection fees for residents (including verified incoming residents). The student's college-town United Way is reached fastest through 2-1-1 or the local UW intake form.`,
      deadline: null,
      deadline_type: 'rolling',
      amount_min: null,
      amount_max: null,
      application_method: 'portal',
    }),
  },

  {
    id: 'county-salvation-army-college-town',
    category: 'local_emergency_assistance',
    source: 'community_foundation',
    matchScore: 78,
    appliesIf: ({ collegeTown }) => Boolean(collegeTown),
    build: ({ collegeTown, collegeState }) => ({
      title: `Salvation Army ${collegeTown}${collegeState ? `, ${collegeState}` : ''} — Emergency Rent & Utility Assistance`,
      sponsor: `The Salvation Army — ${collegeTown} Corps`,
      application_url: 'https://www.salvationarmyusa.org/usn/find-help-near-you',
      description: `The Salvation Army Corps in ${collegeTown} typically operates a rolling emergency assistance fund for first-month rent, security deposit, and utility assistance for low-income residents. Walk-in intake. Bring photo ID, proof of income (FAFSA SAI letter), proof of pending financial aid, and signed lease.`,
      deadline: null,
      deadline_type: 'rolling',
      amount_min: null,
      amount_max: null,
      application_method: 'in_person',
    }),
  },

  {
    id: 'county-catholic-charities',
    category: 'local_emergency_assistance',
    source: 'community_foundation',
    matchScore: 75,
    appliesIf: ({ collegeState }) => Boolean(collegeState),
    build: ({ collegeState, collegeTown }) => ({
      title: `Catholic Charities of ${collegeState} — Emergency Financial Assistance${collegeTown ? ` (${collegeTown})` : ''}`,
      sponsor: `Catholic Charities of ${collegeState}`,
      application_url: 'https://www.catholiccharitiesusa.org/find-help/',
      description: `Catholic Charities operates emergency assistance programs (rent, utilities, food) across ${collegeState}. No religious requirement to receive aid. Walk-in or appointment intake at the regional Family Resource Center serving ${collegeTown || 'the college town'}.`,
      deadline: null,
      deadline_type: 'rolling',
      amount_min: null,
      amount_max: null,
      application_method: 'in_person',
    }),
  },

  {
    id: 'county-dhs-college',
    category: 'state_emergency_assistance',
    source: 'state_portal',
    matchScore: 72,
    appliesIf: ({ collegeCounty, collegeState }) => Boolean(collegeCounty && collegeState),
    build: ({ collegeCounty, collegeState }) => ({
      title: `${collegeCounty} (${collegeState}) DHS — Family Assistance + SNAP + Emergency Cash`,
      sponsor: `${collegeState} Department of Human Services — ${collegeCounty} Office`,
      application_url: 'https://www.benefits.gov/categories/Food%2FNutrition',
      description: `The county DHS office handles applications for SNAP, TANF/Family Assistance Program, and Emergency Cash Assistance. Independent students under 24 may qualify for SNAP if working ≥20 hours/week or in approved work-study; emergency cash is available for documented housing crises. Apply in person at the county DHS office for fastest turnaround.`,
      deadline: null,
      deadline_type: 'rolling',
      amount_min: null,
      amount_max: null,
      application_method: 'in_person',
    }),
  },

  {
    id: 'county-dhs-home',
    category: 'state_emergency_assistance',
    source: 'state_portal',
    matchScore: 70,
    appliesIf: ({ homeCounty, homeState, collegeCounty }) => Boolean(homeCounty && homeState && homeCounty !== collegeCounty),
    build: ({ homeCounty, homeState }) => ({
      title: `${homeCounty} (${homeState}) DHS — Pre-Move Emergency Assistance`,
      sponsor: `${homeState} Department of Human Services — ${homeCounty} Office`,
      application_url: 'https://www.benefits.gov/categories/Food%2FNutrition',
      description: `Apply at the student's CURRENT county DHS for any pre-move emergency cash, SNAP, or Family Assistance — useful for the June/July gap before relocating. Case can be transferred to the college-town county once the student becomes a verified resident there.`,
      deadline: null,
      deadline_type: 'rolling',
      amount_min: null,
      amount_max: null,
      application_method: 'in_person',
    }),
  },
]
